const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

let waitingUser = null;

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  if (waitingUser) {
    socket.partner = waitingUser;
    waitingUser.partner = socket;

    socket.emit("matched");
    waitingUser.emit("matched");

    waitingUser = null;
  } else {
    waitingUser = socket;
  }

  socket.on("signal", (data) => {
    if (socket.partner) socket.partner.emit("signal", data);
  });

  socket.on("disconnect", () => {
    if (waitingUser === socket) waitingUser = null;
    if (socket.partner) socket.partner.emit("partner-left");
  });
});

app.get("/", (req, res) => {
  res.send("YaariZone Backend Running 🚀");
});

server.listen(5000, () => {
  console.log("Server running on port 5000");
});