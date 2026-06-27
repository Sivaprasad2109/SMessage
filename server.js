const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const axios = require('axios');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json());
app.use(rateLimit({ windowMs: 60 * 1000, max: 100 }));
app.use(express.static(path.join(__dirname, "www")));
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
  // --- NEW HELPER: Broadcast the list of active users ---
const broadcastPresence = (rId) => {
    const clients = io.sockets.adapter.rooms.get(rId);
    const users = [];
    if (clients) {
        for (const clientId of clients) {
            const clientSocket = io.sockets.sockets.get(clientId);
            if (clientSocket) {
                users.push({ 
                    name: clientSocket.userName || "Guest", 
                    avatar: clientSocket.userAvatar || "f1.png" 
                });
            }
        }
    }
    // Emit the full list of participants to everyone in the room
    io.to(rId).emit("updateParticipants", users);
};
  
// --- Updated Create Room: Receives 'capacity' and 'roomType' from UI ---
  socket.on("createRoom", (data) => {
    const passcode = generateUniquePasscode();
    const roomId = crypto.randomBytes(16).toString("hex");
    
    const roomType = data && data.roomType ? data.roomType : "private";
    const expiresIn = roomType === "public" ? 0 : (31 * 60 * 1000); 
    const expireAt = expiresIn > 0 ? (Date.now() + expiresIn) : 0;

    // Capture capacity from data, default to 2 if not provided
    const capacity = data && data.capacity ? data.capacity : 2;

    // Store the maxCapacity and roomType in your rooms Map
    rooms.set(passcode, { roomId, expireAt, maxCapacity: capacity, roomType });
    roomIds.set(roomId, passcode);

    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = "Creator"; 
    socket.emit("roomCreated", { passcode, roomId, expireAt, roomType });

    if (expiresIn > 0) {
      setTimeout(() => {
        if (rooms.has(passcode)) {
          rooms.delete(passcode);
          roomIds.delete(roomId);
          io.to(roomId).emit("systemMessage", "⚠️ Room expired.");
          io.socketsLeave(roomId);
        }
      }, expiresIn);
    }
  });

  // --- Updated Join Room: Checks against stored maxCapacity ---
  socket.on("joinRoom", ({ passcode, roomId, name, avatar }) => {
    let roomData = null;
    if (passcode) roomData = rooms.get(String(passcode).trim());
    else if (roomId) {
      const pCode = roomIds.get(roomId);
      if (pCode) roomData = rooms.get(pCode);
    }
    
    if (!roomData) {
      socket.emit("error", { message: "Invalid or expired passcode." });
      return;
    }

    // Use roomData.maxCapacity instead of a hardcoded 2
    const currentRoom = io.sockets.adapter.rooms.get(roomData.roomId);
    if (currentRoom && currentRoom.size >= roomData.maxCapacity) {
      socket.emit("error", { message: `Room is full! Limit is ${roomData.maxCapacity} persons.` });
      return;
    }

    socket.join(roomData.roomId);
    socket.roomId = roomData.roomId;
    const currentSize = io.sockets.adapter.rooms.get(roomData.roomId)?.size || 0;
    io.to(roomData.roomId).emit("updateUserCount", currentSize);
    
    socket.userName = name && name.trim() !== "" ? name : "Guest";
    socket.userAvatar = avatar || "f1.png";

    socket.emit("joinSuccess", { 
        roomId: roomData.roomId, 
        passcode: roomIds.get(roomData.roomId),
        expireAt: roomData.expireAt,
        roomType: roomData.roomType || "private"
    });

    io.to(roomData.roomId).emit("systemMessage", `${socket.userName} joined.`);
    broadcastPresence(roomData.roomId);
  });

  socket.on("sendMessage", ({ message, msgId, replyTo, burn }) => {
    if (!socket.roomId) return; 

    // Rate Limiting Check
    const now = Date.now();
    socket.lastMessageTime = socket.lastMessageTime || 0;
    socket.messageBucket = socket.messageBucket || 0;

    if (now - socket.lastMessageTime < 1000) {
      socket.messageBucket++;
      if (socket.messageBucket > 4) {
        socket.emit("systemMessage", "⚠️ Slow down! You are sending messages too fast.");
        return;
      }
    } else {
      socket.messageBucket = 0;
    }
    socket.lastMessageTime = now;

    // Input Validation Checks
    if (typeof message !== "string" || message.length > 10000) return;
    if (replyTo && (typeof replyTo !== "string" || replyTo.length > 1000)) return;

    // NEW: We now include 'msgId', 'replyTo', and 'burn' in the emission
    socket.to(socket.roomId).emit("newMessage", { 
        message, 
        from: socket.userName || "Guest",
        msgId: msgId,   // This allows the receiver to "mark as seen"
        replyTo: replyTo, // This shows the "Replying to..." text
        burn: !!burn
    });
  });

// ADD THIS NEW LISTENER BELOW IT:
socket.on("messageSeen", ({ roomId, msgId }) => {
    // This tells the sender that their specific message was viewed
    socket.to(roomId).emit("msgStatusUpdate", { 
        msgId: msgId, 
        status: "seen" 
    });
});

  // TYPING INDICATIONS
  socket.on("typing", () => { 
    if (socket.roomId) socket.to(socket.roomId).emit("showTyping", { from: socket.userName }); 
  });
  socket.on("stopTyping", () => { 
    if (socket.roomId) socket.to(socket.roomId).emit("hideTyping"); 
  });

  socket.on("disconnect", () => {
    const rId = socket.roomId;
    const uName = socket.userName || "User"; 

    if (rId) {
        // 1. Update the numerical count immediately for logic checks
        const roomNow = io.sockets.adapter.rooms.get(rId);
        const currentSize = roomNow ? roomNow.size : 0;
        io.to(rId).emit("updateUserCount", currentSize);

        // 2. FEATURE: Refresh the Presence Bar
        // We use a small delay to ensure the socket has fully left the room adapter
        setTimeout(() => {
            broadcastPresence(rId); 
            
            // 3. Optional: Only show the "offline" text if the room still exists
            const roomLater = io.sockets.adapter.rooms.get(rId);
            if (roomLater) {
                io.to(rId).emit("systemMessage", `${uName} went offline.`);
            }
        }, 1000); 
    }
});

  // DESTROY ROOM LOGIC
  socket.on("destroyRoom", () => {
    const roomId = socket.roomId;
    if (roomId) {
      const passcode = roomIds.get(roomId);
      if (passcode) rooms.delete(passcode);
      roomIds.delete(roomId);
      io.to(roomId).emit("systemMessage", "History deleted by user.");
      io.to(roomId).emit("roomDestroyed");
      io.socketsLeave(roomId);
    }
  });
});

server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));

// KEEP ALIVE (Dynamic)
const APP_URL = process.env.APP_URL;
if (APP_URL) {
  setInterval(async () => {
    try {
      const response = await axios.get(APP_URL);
      console.log(`Keep-Alive: Status ${response.status}`);
    } catch (err) {
      console.error("Keep-Alive Failed:", err.message);
    }
  }, 840000);
} else {
  console.log("ℹ️ APP_URL env variable not set. Keep-Alive pinger disabled.");
}
