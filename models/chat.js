const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["Human", "AI"],
      required: true,
    },
    msg: {
      type: String,
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.Mixed,
      ref: "User",
      default: null,
    },
    sessionId: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

const Message = mongoose.model("Message", messageSchema);

module.exports = Message;
