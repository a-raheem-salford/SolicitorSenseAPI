const express = require("express");
const Message = require("../models/chat");
const { v4: uuidv4 } = require("uuid");
const { HumanMessage, AIMessage } = require("@langchain/core/messages");
const authenticateToken = require("../middlewares/authMiddleware");
const { legalChat } = require("../services/chat.service");

const router = express.Router();

router.post("/", authenticateToken, async (req, res) => {
  let pastMessages = [];
  let chat = [];
  try {
    let { msg, sessionId } = req.body;
    let user = req.user;
    const userId = user?.id;

    // If sessionId is not present, generate a random string
    if (!sessionId) {
      sessionId = uuidv4();
    }
    const query = { sessionId, userId };
    chat = await Message.find(query);
    if (chat?.length > 0) {
      pastMessages = chat.map((message) => {
        if (message.type === "AI") {
          return new AIMessage(message.msg);
        } else {
          return new HumanMessage(message.msg);
        }
      });
    }
    const response = await legalChat({
      userInput: msg,
      sessionId,
      pastMessages,
    });

    const newMessage = new Message({
      msg,
      sessionId,
      userId,
      type: "Human",
    });

    await newMessage.save();

    const objAI = {
      msg: response.text,
      sessionId,
      userId,
      type: "AI",
    };

    const messageAI = new Message(objAI);
    await messageAI.save();

    res.status(201).json({
      msg: response.text,
      sessionId,
      userId,
      sources: response.sources,
      fromFallback: response.fallback || false,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get all messages
router.get("/", authenticateToken, async (req, res) => {
  const { sessionId = null } = req.query;
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }
  let user = req.user;
  const userId = user?.id;
  const query = { sessionId, userId };

  try {
    const messages = await Message.find(query);
    res.status(200).json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/list", authenticateToken, async (req, res) => {
  try {
    let user = req.user;
    const userId = user?.id;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const sessionIds = await Message.distinct("sessionId", { userId });

    if (sessionIds.length > 0) {
      const messages = await Message.aggregate([
        {
          $match: { sessionId: { $in: sessionIds } }, // Match messages with sessionIds
        },
        {
          $sort: { sessionId: 1, createdAt: 1 }, // Sort by sessionId and createdAt in descending order
        },
        {
          $group: {
            _id: "$sessionId", // Group by sessionId
            firstMessage: { $first: "$$ROOT" }, // Select the first message in each group
          },
        },
        {
          $replaceRoot: { newRoot: "$firstMessage" }, // Replace the root document with the firstMessage document
        },
        {
          $sort: { createdAt: -1 }, // Sort the final results by createdAt in descending order
        },
      ]);

      res.status(200).json(messages);
    } else {
      res
        .status(404)
        .json({ error: "No sessions found for the provided userId" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a message by ID
router.get("/:id", async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);
    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }
    res.status(200).json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a message by ID
router.delete("/:id", async (req, res) => {
  try {
    const deletedMessage = await Message.findByIdAndDelete(req.params.id);
    if (!deletedMessage) {
      return res.status(404).json({ error: "Message not found" });
    }
    res.status(200).json({ message: "Message deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
