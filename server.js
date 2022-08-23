const express = require("express");
const app = express();
const http = require("http").Server(app);
var cors = require("cors");
// const io = require("socket.io")(http);
app.use(cors());

const io = require("socket.io")(http, {
  cors: {
    // Avoid allowing all origins.
    origin: "*",
    // methods: ["GET", "POST"],
  },
});
const port = process.env.PORT || 3001;
const redis = require("redis");

app.use(express.static(__dirname + "/public"));
app.get("/", (req, res) => {
  res.sendFile("/index.html");
});

// Set up patient and physicist namespaces.
const patients = io.of("/patients");
const physicians = io.of("/physicians");

// Initialize redis client.
const client = redis.createClient(
  {  url: 'redis://myredis-headless'
  }
  );

client.on("error", (err) => console.log("Redis client Error", err));
(async () => {
  await client.connect();
  streamConsumer();

})();

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
          // Read 1 entry at a time, block forever if there are none.
          COUNT: 1,
          BLOCK: 50000,
        }
      );

      if (response) {
        patientId = response[0].messages[0].message.userId;
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
  // Add image to redis' input stream.
  socket.on("image", (msg) => {
    console.info(msg.img.byteLength);
    client.xAdd("main", "*", msg, "MAXLEN", "~", "1000");
    // client.set('dec', msg)
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
