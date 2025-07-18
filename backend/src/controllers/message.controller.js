import dotenv from "dotenv";
dotenv.config();
import cloudinary from "../lib/cloudinary.js";
import { CohereClient } from "cohere-ai";

const cohere = new CohereClient({
  token: process.env.GEMINI_API_KEY,
});

import User from "../models/user.model.js";
import Message from "../models/message.model.js";
import { ScheduledMessage } from "../models/scheduledMessage.model.js";
import { getReceiverSocketId, io } from "../lib/socket.js";
export const getUsersForSidebar = async (req, res) => {
  try {
    const loggedInUserId = req.user._id;

    const filteredUsers = await User.find({
      _id: { $ne: loggedInUserId },
    }).select("-password");

    const usersWithUnread = await Promise.all(
      filteredUsers.map(async (user) => {
        const unreadCount = await Message.countDocuments({
          senderId: user._id,
          receiverId: loggedInUserId,
          read: false,  // ensure your Message schema has a `read` field
        });

        return {
          ...user.toObject(),
          hasUnread: unreadCount > 0,
        };
      })
    );

    res.status(200).json(usersWithUnread);
  } catch (error) {
    console.error("Error in getUsersForSidebar: ", error.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

export const getMessages = async (req, res) => {
  try {
    const { id: userToChatId } = req.params;
    const myId = req.user._id;

    const messages = await Message.find({
      $or: [
        {
          senderId: myId,
          receiverId: userToChatId,
        },
        {
          senderId: userToChatId,
          receiverId: myId,
        },
      ],
    });
    res.status(200).json(messages);
  } catch (error) {
    console.log("Error in getMessages controller", error.message);
    res.status(500).json({ error: "Internal Server error" });
  }
};
export const sendMessage = async (req, res) => {
  try {
    const { text, image, scheduledTime } = req.body;
    const { id: receiverId } = req.params;
    const myId = req.user._id;
    let imageUrl;

    // If image is included, upload to cloudinary
    if (image) {
      const uploadResponse = await cloudinary.uploader.upload(image);
      imageUrl = uploadResponse.secure_url;
    }

    // 🕒 If scheduledTime is provided, save to ScheduledMessage instead of sending now
    if (scheduledTime) {
      const newScheduledMessage = new ScheduledMessage({
        senderId: myId,
        receiverId,
        text,
        image: imageUrl,
        scheduledTime,
      });

      await newScheduledMessage.save();
      return res
        .status(201)
        .json({ message: "✅ Message scheduled successfully" });
    }

    // 🚀 Immediate message send
    const newMessage = new Message({
      senderId: myId,
      receiverId,
      text,
      image: imageUrl,
    });
    await newMessage.save();

    const receiverSocketId = getReceiverSocketId(receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("newMessage", newMessage);
    }

    res.status(201).json(newMessage);
  } catch (error) {
    console.error("❌ Error in sendMessage controller:", error.message);
    res.status(500).json({ message: "Internal Server error" });
  }
};
export const markMessagesAsRead = async (req, res) => {
  const { id: senderId } = req.params;
  const receiverId = req.user._id;

  try {
    await Message.updateMany(
      {
        senderId,
        receiverId,
        read: false,
      },
      { $set: { read: true } }
    );

    res.status(200).json({ message: "✅ Messages marked as read." });
  } catch (error) {
    console.error("❌ Error marking messages as read:", error);
    res.status(500).json({ error: "Failed to mark messages as read." });
  }
};

export const summarizeMessages = async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Invalid or empty messages." });
  }

  const cleanedMessages = messages.filter(
    (m) => typeof m === "string" && m.trim() !== ""
  );

  if (cleanedMessages.length === 0) {
    return res
      .status(400)
      .json({ error: "All messages are empty or invalid." });
  }

  try {
    const response = await cohere.summarize({
      text: cleanedMessages.join("\n"),
      model: "command",
      length: "long", // short, medium, long
      format: "bullets", // paragraph | bullets
      temperature: 0.3, // less randomness
      extractiveness: "low", // low, medium, high
    });

    res.json({ summary: response.summary });
  } catch (error) {
    console.error("Cohere summarization error:", error);
    res.status(500).json({
      error: "Failed to summarize messages.",
      details: error.message || "Unknown error",
    });
  }
};
