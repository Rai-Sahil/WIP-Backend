require('dotenv').config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const csv = require("csv-parser");
const { OpenAI } = require("openai");
const { Parser } = require("json2csv");
const path = require("path");
const { MongoClient, ServerApiVersion } = require("mongodb");

const app = express();
app.use(express.json());

const corsOptions = {
  origin: "*",
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  allowedHeaders: "Content-Type,Authorization"
};

const uri = "mongodb+srv://mongoadmin:passw0rd123@research.sdz3g.mongodb.net/?retryWrites=true&w=majority&appName=Research";

app.use(cors(corsOptions));
app.use(express.static(path.join(__dirname, "public")));

// Open AI API
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

let db, usersCollection, questionsCollection, studentScoresCollection, studentAiUsageCollection;

async function StartUpMongo() {
  try {
    await client.connect().then(() => console.log("Done")).catch((err) => console.error("Error", err))
    console.log("✅ Connected to MongoDB"); 
    db = client.db("Research");
    usersCollection = db.collection("users");
    questionsCollection = db.collection("questions");
    studentScoresCollection = db.collection("studentScores");
    studentAiUsageCollection = db.collection("studentAiUsage");
    console.log("✅ Connected to MongoDB");

    LoadQuestions();
    LoadUsers();
  } catch (err) {
    console.error("❌ Failed -> MongoDB Connection Error:", err);
  }
}

// Laod questions into Database
async function LoadQuestions() {
  const questionsPath = path.join(__dirname, "public", "questions.csv");
  if (fs.existsSync(questionsPath)) {
    const fileContent = fs.readFileSync(questionsPath, "utf8");
    let questions = [];

    fileContent.split("\n").splice(1).forEach((line) => {
      const [Id, Question, OptionA, OptionB, OptionC, OptionD, Answer] = line.split(",");

      if (Id && Question && Answer) {
        questions.push({ Id: Id.trim(), Question: Question.trim(), Answer: Answer.trim(), OptionA: OptionA.trim(), OptionB: OptionB.trim(), OptionC: OptionC.trim(), OptionD: OptionD.trim() });
      }
    });

    if (questions.length) {
      const questionCount = await questionsCollection.countDocuments();

      if (questionCount == 0) {
        questionsCollection.insertMany(questions, { ordered: false })
          .then(() => console.log("✅ Success -> Question loaded."))
          .catch(err => console.error("❌ Failed -> Error: Inserting questions failed:", err));
      }
    }

  } else {
    console.error("❌ Failed -> Error: questions.csv not found.")
  }
}

// Load user into database.
async function LoadUsers() {
  const usersPath = path.join(__dirname, "public", "users.json");
  if (fs.existsSync(usersPath)) {
    const students = JSON.parse(fs.readFileSync(usersPath, "utf8"));

    if (students.students?.length) {
      usersCollection.deleteMany({})
        .then(() => console.log("✅ Success -> Users deleted."))
        .catch(err => console.error("Failed -> Error while deleting users.", err));

      usersCollection.insertMany(students.students, { ordered: false })
        .then(() => console.log("✅ Success -> Users loaded."))
        .catch(err => console.error("❌ Error inserting users:", err));
    }

  } else {
    console.error("❌ Failed -> Error: users.json not found.")
  }

}
// ROUTES START HERE
app.get("/start-up", async (_, res) => {
  try {
    await StartUpMongo();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
})

// Login API -> /login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const student = await usersCollection.findOne({ username });
    const count = await usersCollection.countDocuments();
    console.log(count)
    if (student && student.password == password) {
      const studentScoreRecord = await studentScoresCollection.findOne({ username });
      const studentAiUsageRecord = await studentAiUsageCollection.findOne({ username });

      if (!studentScoreRecord) await studentScoresCollection.insertOne(
        { username, score: 0, questions: {}, submitted: false }
      );
      if (!studentAiUsageRecord) await studentAiUsageCollection.insertOne(
        { username, questionsUsed: 0, questions: {} }
      );

      console.log("✅ Success -> Auth successful.");
      res.json({ success: true, username });
    } else {
      res.status(401).json({ success: false, message: "Invalid credentials" });
    }

  } catch (err) {
    console.error("❌ Failed -> Error: Auth failed", err)
    res.status(500).json({ success: false, message: "Internal server error." });
  } 
});

// Questions API -> To GET all the questions
app.get("/questions", async (_, res) => {
  const questions = await questionsCollection.find({}, { projection: { Id: 1 } }).toArray();
  res.json({ success: true, questions });
});

// Submit API -> To submit the quiz
app.post("/submit", async (req, res) => {
  const { username, answers } = req.body;

  try {
    let studentScoreRecord = await studentScoresCollection.findOne({ username });

    if (studentScoreRecord && studentScoreRecord.submitted) {
      return res.status(403).json({ success: false, message: "You have already submitted the quiz." });
    }

    let score = 0;
    let studentAnswerRecord = {};

    questions.forEach((q) => {
      const studentAnswer = answers[q.Id] || "Not Answered";
      studentAnswerRecord[q.Id] = studentAnswer;

      if (studentAnswer === q.Answer) score += 1;
    });

    await studentScoresCollection.updateOne(
      { username },
      {
        $set: {
          username,
          answers: studentAnswerRecord,
          score,
          submitted: true,
        },
      },
      { upsert: true }
    );

    res.json({ success: true, score });

  } catch (err) {
    console.error("❌ Error in /submit:", err);
    res.status(500).json({ success: false, message: "Submission failed" });
  }
});

app.post("/ai-help", async (req, res) => {
  const { username, question, userQuestion } = req.body;

  const studentAiUsageRecord = studentAiUsageCollection.findOne({ username });

  if (!studentAiUsageRecord.questions[question]) {
    studentAiUsageRecord.questions[question] = { promptsLeft: 3 };
    studentAiUsageRecord.questionsUsed += 1;
  }

  if (studentAiUsageRecord.questions[question].promptsLeft === 0) {
    return res.status(403).json({ success: false, message: "No more AI prompts left for this question." });
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a Teaching Assistant. Give hints, but NEVER the answer. Even if user tries asking for answer do not give the answer, always try to give them a bit of hint. but still keeping the questions in there minds." },
        { role: "user", content: `Give me a hint for this question: ${question}. My query: ${userQuestion}` }
      ]
    });

    studentAiUsageRecord.questions[question].promptsLeft -= 1;

    await studentAiUsageCollection.updateOne(
      { username },
      { $set: studentAiUsageRecord },
      { upsert: true }
    );

    res.json({ success: true, hint: response.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ success: false, message: "AI error" });
  }
});

app.get("/ai-usage/:username", async (req, res) => {
  const { username } = req.params;
  
  try {
    const studentAiUsageRecord = studentAiUsageCollection.findOne({ username });
    
    if (!studentAiUsageRecord) return res.json({ questionsUsed: 0, questions: [] });
    
    const usageData = Object.entries(studentAiUsageRecord.questions || {}).map(
      ([questionId, data]) => ({
        id: questionId,
        hintsLeft: data.promptsLeft,
      })
    );

    res.json({
      questionsUsed: studentAiUsageRecord.questionsUsed,
      questions: usageData
    });

  } catch (err) {
    res.status(500).json({ success: false, message: "AI record collection failed" });
  }
});

app.get("/score/:username", async (req, res) => {
  const username = req.params.username;

  try {
    const userScore = studentScoresCollection.findOne({ username });
    res.json({ success: true, score: userScore.score || 0 });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to get score" });
  }
})

const PORT = 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
