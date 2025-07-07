const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(
      "mongodb+srv://araheem2:1s67XGYglQUKmkKW@solicitorsense.lyze6nu.mongodb.net/?retryWrites=true&w=majority&appName=SolicitorSense"
    );
    console.log(`MongoDB connected: ${conn.connection.host}`);
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
    process.exit(1);
  }
};

module.exports = connectDB;
