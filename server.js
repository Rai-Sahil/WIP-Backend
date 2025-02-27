require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const csv = require("csv-parser");
const { OpenAI } = require("openai");
const { Parser } = require("json2csv"); 

const app = express();
app.use(express.json());
app.use(cors());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let questions = [];
let students = {};
let studentScores = {};
let studentAIUsage = {};

// Load CSV questions
fs.createReadStream("./questions.csv")
  .pipe(csv())
  .on("data", (row) => questions.push(row))
  .on("end", () => console.log("Questions loaded."));

// Load Students
fs.readFile("./users.json", (err, data) => {
  if (!err) students = JSON.parse(data);
});

// ✅ Student Login (No Tokens, Just Simple Validation)
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const student = students.students.find((u) => u.username === username && u.password === password);
  if (student) {
    studentScores[username] = 0;
    studentAIUsage[username] = { questionsUsed: 0, promptsLeft: {} };
    res.json({ success: true, username });
  } else {
    res.status(401).json({ success: false, message: "Invalid credentials" });
  }
});

// ✅ Get Questions
app.get("/questions", (req, res) => {
  res.json(questions);
});

// ✅ Submit Quiz & Calculate Score
app.post("/submit", (req, res) => {
  const { username, answers } = req.body;

  if (studentScores[username]) {
    return res.status(403).json({ success: false, message: "You have already submitted the quiz." });
  }

  let score = 0;
  studentScores[username] = {}; // Store individual answers

  questions.forEach((q) => {
    const userAnswer = answers[q.Id] || "Not Answered";
    studentScores[username][q.Id] = userAnswer; // Save answer
    
    if (userAnswer === q.Answer) {
      score += 1;
    }
  });

  res.json({ success: true, score });
});

// ✅ AI Help (Max 3 Questions, 3 Prompts Each)
app.post("/ai-help", async (req, res) => {
  const { username, question, userQuestion } = req.body;

  if (!studentAIUsage[username]) {
    studentAIUsage[username] = { questionsUsed: 0, promptsLeft: {} };
  }

  const aiUsage = studentAIUsage[username];

  // Check if the maximum number of questions has been used
  if (aiUsage.questionsUsed >= 3) {
    return res.status(403).json({ success: false, message: "AI help used for max 3 questions" });
  }

  // Initialize prompts left for the question
  if (!aiUsage.promptsLeft[question]) {
    aiUsage.promptsLeft[question] = 3;
  }

  // Check if prompts are exhausted for the question
  if (aiUsage.promptsLeft[question] === 0) {
    aiUsage.questionsUsed += 1; // Increment question usage only when prompts are exhausted
    return res.status(403).json({ success: false, message: "No more AI prompts for this question" });
  }
  
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a Teaching Assistant. Give hints, but NEVER the answer." },
        { role: "user", content: `Give me a hint for this question: ${question} My query about this question is ${userQuestion}` }
      ]
    });

    aiUsage.promptsLeft[question] -= 1; // Decrement the number of prompts left for the specific question
    res.json({ success: true, hint: response.choices[0].message.content });
  } catch (error) {
    res.status(500).json({ success: false, message: "AI error" });
  }
});

// ✅ Get Student Score
app.get("/score/:username", (req, res) => {
  const username = req.params.username;
  res.json({ success: true, score: studentScores[username] || 0 });
});

// Download CSV Report
app.get("/download-report", (_, res) => {
  const csvData = [];

  Object.keys(studentScores).forEach((username) => {
    const userAnswers = studentScores[username] || {};
    const aiUsage = studentAIUsage[username] || { questionsUsed: 0, promptsLeft: {} };

    questions.forEach((q) => {
      const userAnswer = userAnswers[q.Id] || "Not Answered";
      console.log(studentScores);
      const isCorrect = userAnswer === q.Answer ? "Correct" : "Wrong";
      const aiHintsUsed = aiUsage.promptsLeft[q[" Question"]] ? 3 - aiUsage.promptsLeft[q[" Question"]] : 0;

      csvData.push({
        Username: username,
        Question: q[" Question"],
        CorrectAnswer: q.Answer,
        UserAnswer: userAnswer,
        Result: isCorrect,
        AI_Hints_Used: aiHintsUsed,
      });
    });
  });

  const parser = new Parser();
  const csv = parser.parse(csvData);

  res.header("Content-Type", "text/csv");
  res.attachment("quiz_report.csv")
  res.send(csv);
})

// ✅ Start Server
app.listen(3000, () => console.log("Server running on port 3000"));

