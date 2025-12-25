const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json());
app.use(rateLimit({ windowMs: 60 * 1000, max: 100 }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/crypto-js", express.static(path.join(__dirname, "node_modules/crypto-js")));

const rooms = new Map(); 
const roomIds = new Map(); 

function generateUniquePasscode() {
  let passcode;
  do {
    passcode = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(passcode));
  return passcode;
}

io.on("connection", (socket) => {
  socket.on("createRoom", () => {
    const passcode = generateUniquePasscode();
    const roomId = crypto.randomBytes(16).toString("hex");
    const expiresIn = 40 * 60 * 1000; 
    const expireAt = Date.now() + expiresIn;

    rooms.set(passcode, { roomId, expireAt });
    roomIds.set(roomId, passcode);

    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit("roomCreated", { passcode, roomId, expireAt });

    setTimeout(() => {
      if (rooms.has(passcode)) {
        rooms.delete(passcode);
        roomIds.delete(roomId);
        io.to(roomId).emit("systemMessage", "⚠️ Room expired.");
        io.socketsLeave(roomId);
      }
    }, expiresIn);
  });

  socket.on("joinRoom", ({ passcode, roomId, name }) => {
    let roomData = null;
    if (passcode) roomData = rooms.get(String(passcode).trim());
    else if (roomId) {
      const pCode = roomIds.get(roomId);
      if (pCode) roomData = rooms.get(pCode);
    }
    
    if (!roomData) {
      socket.emit("systemMessage", "Invalid or expired passcode.");
      return;
    }

    socket.join(roomData.roomId);
    socket.roomId = roomData.roomId;
    socket.userName = name || "Anonymous";

    socket.emit("joinSuccess", { 
        roomId: roomData.roomId, 
        passcode: roomIds.get(roomData.roomId),
        expireAt: roomData.expireAt 
    });

    // FIX: Notify everyone in the room that a user joined
    io.to(roomData.roomId).emit("systemMessage", `${socket.userName} joined.`);
  });

  socket.on("sendMessage", ({ message }) => {
    if (!socket.roomId) return; 
    socket.to(socket.roomId).emit("newMessage", { message, from: socket.userName });
  });

  socket.on("typing", () => { if (socket.roomId) socket.to(socket.roomId).emit("showTyping"); });
  socket.on("stopTyping", () => { if (socket.roomId) socket.to(socket.roomId).emit("hideTyping"); });

  socket.on("disconnect", () => {
    const rId = socket.roomId;
    const uName = socket.userName || "User";
    if (rId) {
      setTimeout(() => {
        const room = io.sockets.adapter.rooms.get(rId);
        if (!room || room.size < 2) {
          io.to(rId).emit("systemMessage", `${uName} went offline.`);
        }
      }, 8000); 
    }
  });
});

server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
