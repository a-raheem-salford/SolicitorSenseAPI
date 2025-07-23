const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  msg: { 
    type: String, 
    required: true 
  },
  sessionId: { 
    type: String, 
    required: true,
    index: true 
  },
  userId: { 
    type: String, 
    required: true,
    index: true 
  },
  type: { 
    type: String, 
    enum: ['Human', 'AI'], 
    required: true 
  },
  
  // Document-related fields
  hasDocuments: { 
    type: Boolean, 
    default: false 
  },
  documentNames: [{ 
    type: String 
  }],
  documentCount: { 
    type: Number, 
    default: 0 
  },
  
  // NEW: Document processing results
  documentResults: [{
    filename: {
      type: String,
      required: true
    },
    processed: {
      type: Boolean,
      required: true
    },
    irrelevant: {
      type: Boolean,
      default: false
    },
    documentType: {
      type: String,
      default: null
    },
    error: {
      type: String,
      default: null
    }
  }],
  
  // NEW: Summary fields for quick access
  irrelevantCount: { 
    type: Number, 
    default: 0 
  },
  processedCount: {
    type: Number,
    default: 0
  },
  
}, { 
  timestamps: true 
});

// Compound index for efficient queries
messageSchema.index({ sessionId: 1, userId: 1, createdAt: 1 });

module.exports = mongoose.model("Message", messageSchema);