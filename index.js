
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./database/conn");
const parseXML = require("./routes/lawData.routes");
const authRoutes = require("./routes/auth.routes");
const messageRoutes = require("./routes/chat.routes");

const app = express();
app.use(express.json());
app.use(cors());
connectDB();

app.get("/", (req, res) => {
  res.send("Successful response.");
});
app.use("/parseXML", parseXML);
app.use('/api/auth', authRoutes);
app.use("/chat", messageRoutes)

app.listen(4000, () => console.log("Example app is listening on port 4000."));


