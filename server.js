const express = require("express");
const app = express();
const http = require("http").Server(app);
var cors = require("cors");
var FormData = require('form-data');
app.use(cors());

const io = require("socket.io")(http, {
  cors: {
    // Avoid allowing all origins.
    origin: "*",
    // methods: ["GET", "POST"],
  },
});
const port = process.env.PORT || 3001;
const redisWorkerEnabled = process.env.ENABLE_REDIS_WORKER || 'true';
const celeryWorkerEnabled = process.env.ENABLE_CELERY_WORKER || 'false';
const bentoWorkerEnabled = process.env.ENABLE_BENTOML_WORKER || 'false';
const CELERY_BROKER_URL = process.env.CELERY_BROKER_URL || 'amqp://admin:mypass@rabbitmq-service:5672';
const CELERY_RESULT_BACKEND = process.env.CELERY_RESULT_BACKEND || 'redis://myredis-headless:6379/0';
const YATAI_DEPLOYMENT_URL = process.env.YATAI_DEPLOYMENT_URL || 'http://emotion-analyzer-yatai.127.0.0.1.sslip.io/predict_async';



const redis = require("redis");

app.use(express.static(__dirname + "/public"));
app.get("/", (req, res) => {
  res.sendFile("/index.html");
});

const celery = require('celery-node');

if(celeryWorkerEnabled === 'true'){
  var celery_app = celery.createClient(
    CELERY_BROKER_URL,
    CELERY_RESULT_BACKEND
  );
}

// Set up patient and physicist namespaces.
const patients = io.of("/patients");
const physicians = io.of("/physicians");

// Initialize redis client.
if(redisWorkerEnabled === 'true'){
  var client = redis.createClient(
    {  url: 'redis://myredis-headless'
    }
    );
  
  client.on("error", (err) => console.log("Redis client Error", err));
  (async () => {
    await client.connect();
    streamConsumer();
  
  })();
}

// consume new elements of output emotion stream
async function streamConsumer() {
  let currentId = "$"; // Use as last ID the maximum ID already stored in the stream
  let patientId;
  while (true) {
    try {
      let response = await client.xRead(
        redis.commandOptions({
          isolated: true,
        }),
        [
          // XREAD can read from multiple streams, starting at a
          // different ID for each...
          {
            key: "main:results",
            id: currentId,
          },
        ],
        {
          // Read 1 entry at a time, block for 5 seconds if there are none.
          COUNT: 1,
          BLOCK: 50000,
        }
      );

      if (response) {
        patientId = response[0].messages[0].message.userId;
        console.log(response[0].messages[0].message);
        physicians
          .to(patientId)
          .volatile.emit("emotion", response[0].messages[0].message.emotions);
        // Get the ID of the first (only) entry returned.
        currentId = response[0].messages[0].id;
      }
    } catch (err) {
      console.error(err);
    }
  }
}


// Handle patient connections.
 patients.on("connection", (socket) => {
  console.log("patient connected");
  // Add image to redis' input stream and/or celery worker.
  socket.on("image",  (msg) => {
    console.info(`Image of size ${msg.img.byteLength} received.`);

    if(redisWorkerEnabled === 'true'){
      client.xAdd("main", "*", msg, "MAXLEN", "~", "1000");

    }
    if(celeryWorkerEnabled === 'true'){
      request = {"usr": msg.userId, "image": msg.img}
      celery_app.sendTask("tasks.EmotionRecognition", undefined, {'request': request} )
    }
    if(bentoWorkerEnabled === 'true'){
      const formData = new FormData()
      const annotations = {userId: msg.userId, conferenceId: msg.conferenceId }

      formData.append('annotations', JSON.stringify(annotations))
      formData.append('image', msg.img, 'patient.png')


    formData.submit(YATAI_DEPLOYMENT_URL, function(err, res) {
      const body = []
      res.on('data', 
        (chunk) => body.push(chunk)
      );
      res.on('end', () => {
        const resString = Buffer.concat(body).toString()
        const emotions = JSON.parse(resString).emotions
        physicians
        .to(emotions.userId)
        .volatile.emit("emotion", JSON.stringify(emotions));
      })
    });


    }

  });

    
  socket.on("disconnect", (reason) => {
    console.log("patient disconnected");
  });
});

// Handle physicians connections
physicians.on("connection", function (socket) {
  console.log("physician connected");

  socket.on("subscribe", function (patientId) {
    socket.join(patientId);
  });
  socket.on("unsubscribe", function (patientId) {
    socket.leave(patientId);
  });

  socket.on("disconnect", (reason) => {
    console.log("physician disconnected");
  });
});



// Handle all connections. For testing purposes.
io.on("connection", (socket) => {
  console.log("main namespace connected");

// Handle incoming messages from celery worker.
socket.on("send_result_to_server", (msg) => {
  for (const patientResult of msg.data) {
    console.log(patientResult);
    const  patientId = patientResult.userId;
    physicians
      .to(patientId)
      .volatile.emit("emotion", patientResult.emotions);
  }
  


});

  socket.on("chat message", (msg) => {
    // io.emit("chat message", msg);
    io.to("test").emit("chat message", msg);
  });
  socket.on("disconnect", (reason) => {
    console.log("main namespace disconnected");
  });

  socket.on("subscribe", function (patientId) {
    socket.join(patientId);
  });
});

http.listen(port, () => {
  console.log(`Socket.IO server running at http://localhost:${port}/`);
});