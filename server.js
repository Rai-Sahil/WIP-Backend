require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const csv = require("csv-parser");
const { OpenAI } = require("openai");
const { Parser } = require("json2csv");
const path = require("path");

const app = express();
app.use(express.json());

const corsOptions = {
  origin: "*", // Allows requests from ANY frontend
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  allowedHeaders: "Content-Type,Authorization"
};


app.use(cors(corsOptions));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let questions = [];
let students = {};
let studentScores = {};
let studentAIUsage = {};

// ✅ Load Questions Synchronously
const questionsPath = path.join(__dirname, "public", "questions.csv");
if (fs.existsSync(questionsPath)) {
  const fileContent = fs.readFileSync(questionsPath, "utf8");
  fileContent
    .split("\n")
    .slice(1) // Skip CSV header
    .forEach((line) => {
      const [Id, Question, OptionA, OptionB, OptionC, OptionD, Answer] = line.split(",");
      if (Id && Question && Answer) {
        questions.push({ Id: Id.trim(), Question: Question.trim(), Answer: Answer.trim(), OptionA: OptionA.trim(), OptionB: OptionB.trim(), OptionC: OptionC.trim(), OptionD: OptionD.trim()});
      }
    });
  console.log("✅ Questions loaded.");
} else {
  console.error("❌ Error: questions.csv not found.");
}

// ✅ Load Users Synchronously
const usersPath = path.join(__dirname, "public", "users.json");
if (fs.existsSync(usersPath)) {
  students = JSON.parse(fs.readFileSync(usersPath, "utf8"));
  console.log("✅ Users loaded.");
} else {
  console.error("❌ Error: users.json not found.");
}

// ✅ Student Login
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const student = students.students.find((u) => u.username === username && u.password === password);
  if (student) {
    studentScores[username] = 0;
    studentAIUsage[username] = { questionsUsed: 0, questions: {} };
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
  studentScores[username] = {};

  questions.forEach((q) => {
    const userAnswer = answers[q.Id] || "Not Answered";
    studentScores[username][q.Id] = userAnswer;

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
    studentAIUsage[username] = { questionsUsed: 0, questions: {} };
  }

  const aiUsage = studentAIUsage[username];

  // Check AI usage limits
  if (aiUsage.questionsUsed >= 3 && !aiUsage.questions[question]) {
    return res.status(403).json({ success: false, message: "AI help allowed for only 3 questions." });
  }

  if (!aiUsage.questions[question]) {
    aiUsage.questions[question] = { promptsLeft: 3 };
    aiUsage.questionsUsed += 1;
  }

  if (aiUsage.questions[question].promptsLeft === 0) {
    return res.status(403).json({ success: false, message: "No more AI prompts for this question." });
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a Teaching Assistant. Give hints, but NEVER the answer." },
        { role: "user", content: `Give me a hint for this question: ${question}. My query: ${userQuestion}` }
      ]
    });

    aiUsage.questions[question].promptsLeft -= 1;
    res.json({ success: true, hint: response.choices[0].message.content });
  } catch (error) {
    res.status(500).json({ success: false, message: "AI error" });
  }
});

// ✅ Get AI usage data for a user
app.get("/ai-usage/:username", (req, res) => {
  const { username } = req.params;
  const aiUsage = studentAIUsage[username] || { questionsUsed: 0, questions: {} };

  // Format data for the frontend
  const usageData = Object.keys(aiUsage.questions).map((questionId) => ({
    id: questionId,
    hintsLeft: aiUsage.questions[questionId].promptsLeft,
  }));

  res.json(usageData);
});

// ✅ Get Student Score
app.get("/score/:username", (req, res) => {
  const username = req.params.username;
  res.json({ success: true, score: studentScores[username] || 0 });
});

// ✅ Download CSV Report
app.get("/download-report", (_, res) => {
  const csvData = [];

  Object.keys(studentScores).forEach((username) => {
    const userAnswers = studentScores[username] || {};
    const aiUsage = studentAIUsage[username] || { questionsUsed: 0, questions: {} };

    questions.forEach((q) => {
      const userAnswer = userAnswers[q.Id] || "Not Answered";
      const isCorrect = userAnswer === q.Answer ? "Correct" : "Wrong";
      const aiHintsUsed = aiUsage.questions[q.Question] ? 3 - aiUsage.questions[q.Question].promptsLeft : 0;

      csvData.push({
        Username: username,
        Question: q.Question,
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
  res.attachment("quiz_report.csv");
  res.send(csv);
});

// ✅ Start Server
app.listen(3000, () => console.log("🚀 Server running on port 3000"));

