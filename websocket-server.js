const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Create HTTP server
const server = http.createServer();

const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Store active users and their connections
const activeUsers = new Map();
const userSockets = new Map();
const communityMembers = new Map();
const channelMembers = new Map();
const typingUsers = new Map();

// Verify JWT token
const verifyToken = async (token) => {
  try {
    const decoded = jwt.verify(token, process.env.NEXTAUTH_SECRET);
    return {
      id: decoded.id || decoded.sub,
      name: decoded.name,
      email: decoded.email,
      image: decoded.picture || decoded.image,
    };
  } catch (error) {
    console.error("Token verification failed:", error);
    return null;
  }
};

// Socket.IO auth middleware (TEMPORARY BYPASS FOR TESTING)
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    console.log("🔐 Received token:", token);

    if (!token) {
      console.warn("⚠️ Token missing. Allowing connection for testing.");
      return next(); // Remove this line when enforcing auth again
    }

    const user = await verifyToken(token);
    if (!user) {
      return next(new Error("Invalid authentication token"));
    }

    socket.data.user = user;
    next();
  } catch (error) {
    console.error("Socket authentication error:", error);
    next(new Error("Authentication failed"));
  }
});

// WebSocket events
io.on("connection", (socket) => {
  const user = socket.data.user || { id: "guest", name: "Guest User", image: "" };
  const userId = user.id;
  const username = user.name;
  const userImage = user.image;

  console.log(`✅ User connected: ${username} (${userId})`);

  // Add user to active list
  activeUsers.set(userId, {
    id: userId,
    name: username,
    image: userImage,
    status: "online",
    lastActive: new Date(),
    socketId: socket.id,
  });

  if (!userSockets.has(userId)) {
    userSockets.set(userId, new Set());
  }
  userSockets.get(userId).add(socket.id);

  socket.join(`user:${userId}`);

  io.emit("user:status", {
    userId,
    status: "online",
    lastActive: new Date(),
  });

  socket.on("joinCommunity", (communityId) => {
    console.log(`User ${username} joined community ${communityId}`);
    socket.join(`community:${communityId}`);

    if (!communityMembers.has(communityId)) {
      communityMembers.set(communityId, new Map());
    }
    communityMembers.get(communityId).set(userId, {
      id: userId,
      name: username,
      image: userImage,
      status: "online",
      lastActive: new Date(),
    });

    socket.to(`community:${communityId}`).emit("community:member:joined", {
      communityId,
      user: {
        id: userId,
        name: username,
        image: userImage,
        status: "online",
      },
    });

    const onlineMembers = Array.from(communityMembers.get(communityId).values());
    socket.emit("community:members", {
      communityId,
      members: onlineMembers,
    });
  });

  socket.on("newPost", async (post) => {
    io.emit("newPost", post);

    try {
      await fetch(`${process.env.API_URL}/api/posts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${socket.handshake.auth.token}`,
        },
        body: JSON.stringify(post),
      });
    } catch (error) {
      console.error("Error saving post via API:", error);
    }
  });

  socket.on("direct:message", async (data) => {
    const { recipientId, message } = data;

    try {
      const response = await fetch(`${process.env.API_URL}/api/chat/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${socket.handshake.auth.token}`,
        },
        body: JSON.stringify({
          chatId: message.chatId,
          content: message.content,
          mediaUrl: message.mediaUrl,
          mediaType: message.mediaType,
        }),
      });

      if (!response.ok) throw new Error("Failed to save message");

      const savedMessage = await response.json();

      if (userSockets.has(recipientId)) {
        userSockets.get(recipientId).forEach((socketId) => {
          io.to(socketId).emit("direct:message:new", savedMessage.message);
        });
      }

      socket.emit("direct:message:sent", savedMessage.message);
    } catch (error) {
      console.error("Error saving direct message:", error);
      socket.emit("error", { message: "Failed to send message" });
    }
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${username} (${userId})`);

    if (userSockets.has(userId)) {
      userSockets.get(userId).delete(socket.id);

      if (userSockets.get(userId).size === 0) {
        if (activeUsers.has(userId)) {
          const userData = activeUsers.get(userId);
          userData.status = "offline";
          userData.lastActive = new Date();
          activeUsers.set(userId, userData);
        }

        io.emit("user:status", {
          userId,
          status: "offline",
          lastActive: new Date(),
        });

        for (const [communityId, members] of communityMembers.entries()) {
          if (members.has(userId)) {
            members.delete(userId);
            io.to(`community:${communityId}`).emit("community:member:left", {
              communityId,
              userId,
            });
          }
        }

        for (const [channelId, members] of channelMembers.entries()) {
          if (members.has(userId)) {
            members.delete(userId);
            io.to(`channel:${channelId}`).emit("channel:member:left", {
              channelId,
              userId,
            });
          }
        }

        for (const [channelId, typingMap] of typingUsers.entries()) {
          if (typingMap.has(userId)) {
            typingMap.delete(userId);
            io.to(`channel:${channelId}`).emit(`channel:${channelId}:typing`, {
              channelId,
              userId,
              isTyping: false,
            });
          }
        }
      }
    }
  });
});

// ✅ Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ WebSocket server running on port ${PORT}`);
});
