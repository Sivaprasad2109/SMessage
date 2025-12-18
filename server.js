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
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 100 }));

app.use(express.static(path.join(__dirname, "public")));
app.use("/crypto-js", express.static(path.join(__dirname, "node_modules/crypto-js")));

/* ===================== ROOM STORE ===================== */
const rooms = new Map(); // passcode -> { roomId, expireAt }
const roomIds = new Map(); // roomId -> passcode (for reverse lookup)

function generateUniquePasscode() {
  let passcode;
  do {
    passcode = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(passcode));
  return passcode;
}

/* ===================== SOCKET ===================== */
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  /* ---------- CREATE ROOM ---------- */
  socket.on("createRoom", () => {
    const passcode = generateUniquePasscode();
    const roomId = crypto.randomBytes(16).toString("hex");
    const expiresIn = 40 * 60 * 1000; // Increased to 40 mins for stability
    const expireAt = Date.now() + expiresIn;

    rooms.set(passcode, { roomId, expireAt });
    roomIds.set(roomId, passcode); // Reverse mapping

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

  /* ---------- JOIN ROOM ---------- */
  socket.on("joinRoom", ({ passcode, roomId, name }) => {
    let roomData = null;

    // 1. Try to find room by Passcode (Joiner)
    if (passcode) {
      roomData = rooms.get(String(passcode).trim());
    } 
    // 2. Try to find room by RoomId (Creator or Reload)
    else if (roomId) {
      const pCode = roomIds.get(roomId);
      if (pCode) roomData = rooms.get(pCode);
    }
    
    if (!roomData) {
      socket.emit("systemMessage", "Invalid or expired passcode.");
      return;
    }

    const members = io.sockets.adapter.rooms.get(roomData.roomId);
    if (members && members.size >= 2 && !socket.rooms.has(roomData.roomId)) {
      socket.emit("systemMessage", "Room is full.");
      return;
    }

    socket.join(roomData.roomId);
    socket.roomId = roomData.roomId;
    socket.userName = name || "Anonymous";

    // Inform the client exactly which IDs to use from now on
    socket.emit("joinSuccess", { 
        roomId: roomData.roomId, 
        passcode: roomIds.get(roomData.roomId),
        expireAt: roomData.expireAt 
    });

    io.to(roomData.roomId).emit("systemMessage", `${socket.userName} joined.`);
  });

  /* ---------- MESSAGE & TYPING ---------- */
  socket.on("sendMessage", ({ message }) => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit("newMessage", { message, from: socket.userName });
  });

  socket.on("typing", () => {
    if (socket.roomId) socket.to(socket.roomId).emit("showTyping");
  });

  socket.on("stopTyping", () => {
    if (socket.roomId) socket.to(socket.roomId).emit("hideTyping");
  });

  socket.on("quitRoom", () => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit("systemMessage", `${socket.userName} left.`);
    socket.leave(socket.roomId);
  });

  socket.on("disconnect", () => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit("systemMessage", `${socket.userName || "User"} disconnected.`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
