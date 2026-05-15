// server.js
import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.send("Backend OK");
});

app.listen(3000, () => console.log("Server running hello lol"));