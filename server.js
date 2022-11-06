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
  }, maxHttpBufferSize: 1e8,
});
const port = process.env.PORT || 3001;
const redisWorkerEnabled = process.env.ENABLE_REDIS_WORKER || 'false';
const celeryWorkerEnabled = process.env.ENABLE_CELERY_WORKER || 'false';
const bentoWorkerEnabled = process.env.ENABLE_BENTOML_WORKER || 'true';
const REDIS_URL = process.env.REDIS_URL || 'redis://myredis-headless';
const CELERY_BROKER_URL = process.env.CELERY_BROKER_URL || 'amqp://admin:mypass@rabbitmq-service:5672';
const CELERY_RESULT_BACKEND = process.env.CELERY_RESULT_BACKEND || 'redis://myredis-headless:6379/0';
const YATAI_DEPLOYMENT_URL = process.env.YATAI_DEPLOYMENT_URL || 'http://0.0.0.0:3000/predict_async';

// Keep track of analyzed users and last message IDs received from Redis streams.
// Only needed for Redis. Key: user_id. Value: message_id 
const analyzed_users = {} 

const redis = require("redis");

app.use(express.static(__dirname + "/public"));
app.get("/", (req, res) => {
  res.sendFile("/index.html");
});

const celery = require('celery-node');

if (celeryWorkerEnabled === 'true') {
  var celery_app = celery.createClient(
    CELERY_BROKER_URL,
    CELERY_RESULT_BACKEND
  );
}

// Set up patient and physicist namespaces.
const patients = io.of("/patients");
const physicians = io.of("/physicians");

// Initialize redis client.
if (redisWorkerEnabled === 'true') {
  var cluster = redis.createCluster({
    rootNodes: [
      {
        url: 'redis://redis-cluster-0.redis-cluster-headless:6379'
      },
      {
        url: 'redis://redis-cluster-1.redis-cluster-headless:6379'
      },
      {
        url: 'redis://redis-cluster-2.redis-cluster-headless:6379'
      }
    ]
  });
  
  cluster.on("error", (err) => console.log("Redis cluster Error", err));
  (async () => {
    await cluster.connect();
    streamConsumer();
  
  })();
  
   // consume new elements of output emotion stream
 async function streamConsumer() {
  while (true) {
    try {
      let response = await cluster.xRead(
        redis.commandOptions({
          isolated: true,
        }),
        Object.entries(analyzed_users).map(e => ({key:`output:results:{${e[0]}}`, id: e[1]}))
       ,
        {
          // Read at maximum 20 entries at a time of every stream. Block basically forever if there are none. 
          // Block gets released as soon as 1 message is available. i.e. BLOCK n + COUNT m will return one message.
          COUNT: 20,
          BLOCK: 999999,
        }
      );

      if (response) {
        for (const stream of response) {
          const messages_length = stream.messages?.length;
          if(messages_length){
            const userId = stream.messages[0].message.userId;
            // TODO Check if assumption that messages of Redis response are ordered by auto-generated id is right.
            analyzed_users.userId = stream.messages[messages_length-1].id;
          }
          for (const result of stream) {
            physicians.to(userId).volatile.emit("emotion", result.message.emotions);
          }
        }
      }
    } catch (err) {
      console.error(err);
    }
  }
}
}




// Handle patient connections.
patients.on("connection", (socket) => {
  console.log("patient connected");
  // Add image to redis' input stream and/or celery worker.
  socket.on("image", (msg) => {
    if (typeof msg.img === 'undefined') {
      console.log('Warning: Image event got triggered without an image attached.')
      return;
    }
    console.info(`Image of size ${msg.img.byteLength} received.`);

    if (redisWorkerEnabled === 'true') {
      cluster.xAdd(`input:emotions:{${msg.userId}}`, "*", msg, "MAXLEN", "~", "1000");

    }
    if (celeryWorkerEnabled === 'true') {
      request = { "usr": msg.userId, "image": msg.img }
      celery_app.sendTask("tasks.EmotionRecognition", undefined, { 'request': request })
    }
    if (bentoWorkerEnabled === 'true') {
      const formData = new FormData()
      const annotations = { userId: msg.userId, conferenceId: msg.conferenceId }

      formData.append('annotations', JSON.stringify(annotations))
      formData.append('image', msg.img, 'patient.png')


      formData.submit(YATAI_DEPLOYMENT_URL, function (err, res) {
        if (err) {
          console.log(err);
        }
        else {
          const body = []
          res.on('data',
            (chunk) => body.push(chunk)
          );
          res.on('end', () => {
            try {
              const resString = Buffer.concat(body).toString()
              const reply = JSON.parse(resString)
              console.log('Received BentoML Worker Result:')
              console.log(reply)
              console.log(reply.output.length)
              if (reply.output.length > 0) {
                physicians
                  .to(reply.emotions.userId)
                  .volatile.emit("emotion", JSON.stringify(reply.emotions));
              }
            }
            catch (error) {
              console.log('BentoML Worker Error:')
              console.error(error);
            }
          })
        }
      });


    }

  });


  socket.on("disconnect", (reason) => {
    console.log(`patient disconnected. Reason: ${reason}`);
  });
});

// Handle physicians connections
physicians.on("connection", function (socket) {
  console.log("physician connected");

  socket.on("subscribe", function (patientId) {
    socket.join(patientId);
    // Start with maximum ID that's already stored in Redis.
    analyzed_users.patientId = '$'
  });
  socket.on("unsubscribe", function (patientId) {
    socket.leave(patientId);
    delete analyzed_users.patientId;
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
      console.log('Received Celery Worker Result:')
      console.log(patientResult);
      const patientId = patientResult.userId;
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

