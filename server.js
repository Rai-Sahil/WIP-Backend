require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
const { MongoClient, ServerApiVersion } = require("mongodb");

const app = express();
app.use(express.json());
app.use(cors({ origin: "*", methods: "GET,HEAD,PUT,PATCH,POST,DELETE", allowedHeaders: "Content-Type,Authorization" }));
app.use(express.static(path.join(__dirname, "public")));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const uri = "mongodb+srv://mongoadmin:passw0rd123@research.sdz3g.mongodb.net/?retryWrites=true&w=majority&appName=Research";
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

let db, usersCollection, questionsCollection, studentScoresCollection, studentAiUsageCollection;

async function connectMongoDB() {
  try {
    await client.connect();
    db = client.db("Research");
    usersCollection = db.collection("users");
    questionsCollection = db.collection("questions");
    studentScoresCollection = db.collection("studentScores");
    studentAiUsageCollection = db.collection("studentAiUsage");
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err);
  }
}

async function loadQuestions() {
  const questionsPath = path.join(__dirname, "public", "questions.csv");
  if (!fs.existsSync(questionsPath)) return console.error("❌ questions.csv not found.");

  const questions = fs.readFileSync(questionsPath, "utf8")
    .split("\n").slice(1)
    .map(line => {
      const [Id, Question, OptionA, OptionB, OptionC, OptionD, Answer] = line.split(",");
      return Id && Question && Answer ? { Id, Question, Answer, OptionA, OptionB, OptionC, OptionD } : null;
    }).filter(q => q);

  if (questions.length && await questionsCollection.countDocuments() === 0) {
    await questionsCollection.insertMany(questions).then(() => console.log("✅ Questions loaded."))
      .catch(err => console.error("❌ Error inserting questions:", err));
  }
}

async function loadUsers() {
  const usersPath = path.join(__dirname, "public", "users.json");
  if (!fs.existsSync(usersPath)) return console.error("❌ users.json not found.");

  const students = JSON.parse(fs.readFileSync(usersPath, "utf8")).students || [];
  if (students.length && await usersCollection.countDocuments() === 0) {
    await usersCollection.insertMany(students).then(() => console.log("✅ Users loaded."))
      .catch(err => console.error("❌ Error inserting users:", err));
  }
}

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const student = await usersCollection.findOne({ username });
    if (!student || student.password !== password) return res.status(401).json({ success: false, message: "Invalid credentials" });

    await studentScoresCollection.updateOne({ username }, { $setOnInsert: { username, score: 0, questions: {}, submitted: false } }, { upsert: true });
    await studentAiUsageCollection.updateOne({ username }, { $setOnInsert: { username, questionsUsed: 0, questions: {} } }, { upsert: true });

    res.json({ success: true, username });
  } catch (err) {
    console.error("❌ Login Error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

app.get("/questions", async (_, res) => {
  res.json({ success: true, questions: await questionsCollection.find().toArray() });
});

app.post("/submit", async (req, res) => {
  const { username, answers } = req.body;
  try {
    const studentRecord = await studentScoresCollection.findOne({ username });
    if (studentRecord?.submitted) return res.status(403).json({ success: false, message: "Already submitted." });
    
    let score = 0;
    let studentAnswerRecord = {};
    const questions = await questionsCollection.find().toArray();

    questions.forEach(q => {
      const studentAnswer = answers[q.Id] || "Not Answered";
      studentAnswerRecord[q.Id] = studentAnswer;
      if (studentAnswer === q.Answer) score++;
    });

    await studentScoresCollection.updateOne({ username }, { $set: { quesitons: questions, answers: studentAnswerRecord, score, submitted: true } }, { upsert: true });
    res.json({ success: true, score });
  } catch (err) {
    console.error("❌ Submission Error:", err);
    res.status(500).json({ success: false, message: "Submission failed" });
  }
});

app.post("/ai-help", async (req, res) => {
  const { username, question, userQuestion } = req.body;
  try {
    const studentRecord = await studentAiUsageCollection.findOne({ username }) || { questions: {} };
    studentRecord.questions[question] = studentRecord.questions[question] || { promptsLeft: 3 };
    
    if (studentRecord.questions[question].promptsLeft === 0) return res.status(403).json({ success: false, message: "No more AI prompts left." });
    
    // If student record history doesnt exist, create it.
    if (!studentRecord.questions[question].history) studentRecord.questions[question].history = [];

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { "role": "system", "content": "You are a strict Teaching Assistant conducting an exam. Your job is ONLY to provide hints—never full answers. You must NEVER give an answer, confirm correctness, or provide a response that directly leads to the solution. If the hint makes the answer obvious, rephrase it to be more indirect." },
        { "role": "user", "content": `Provide a hint for this question: ${question}. Student's Query: ${userQuestion}. IMPORTANT: Do NOT give away the answer. Only provide guidance that helps them think critically without revealing the solution.` }
      ]
    });

    const hint = response.choices[0].message.content;
    studentRecord.questions[question].history.push({ userQuestion, hint });
    
    studentRecord.questions[question].promptsLeft--;
    await studentAiUsageCollection.updateOne({ username }, { $set: studentRecord }, { upsert: true });
    res.json({ success: true, hint });
  } catch (err) {
    console.error("❌ AI Help Error:", err);
    res.status(500).json({ success: false, message: "AI error" });
  }
});

app.get("/score/:username", async (req, res) => {
  const { username } = req.params;
  try {
    const userScore = await studentScoresCollection.findOne({ username }) || {};
    res.json({ success: true, score: userScore.score || 0 });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to get score" });
  }
});

app.get("/ai-usage/:username", async (req, res) => {
  const { username } = req.params;

  try {
    const studentAiUsageRecord = await studentAiUsageCollection.findOne({ username });

    if (!studentAiUsageRecord) {
      return res.json({ success: true, questionsUsed: 0, questions: [] });
    }

    const questionsData = Object.entries(studentAiUsageRecord.questions || {}).map(
      ([questionId, data]) => ({
        id: questionId,
        hintsLeft: data.promptsLeft || 0,
      })
    );

    res.json({
      success: true,
      questionsUsed: studentAiUsageRecord.questionsUsed || 0,
      questions: questionsData
    });

  } catch (err) {
    console.error("❌ Error fetching AI usage data:", err);
    res.status(500).json({ success: false, message: "Failed to fetch AI usage data." });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  await connectMongoDB();
  await loadQuestions();
  await loadUsers();
});

