import express from "express"
import fs from "fs"
import http from "http"
import path from "path"
import { Server } from "socket.io"
import { fileURLToPath } from "url"
import { GoogleGenerativeAI } from "@google/generative-ai"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.join(__dirname, "..")
const envPath = path.join(projectRoot, ".env")
const clientDistPath = path.join(projectRoot, "client", "dist")

if (fs.existsSync(envPath)) {
  const envLines = fs.readFileSync(envPath, "utf8").split(/\r?\n/)

  for (const line of envLines) {
    const trimmedLine = line.trim()

    if (!trimmedLine || trimmedLine.startsWith("#")) continue

    const separatorIndex = trimmedLine.indexOf("=")
    if (separatorIndex === -1) continue

    const key = trimmedLine.slice(0, separatorIndex).trim()
    const value = trimmedLine.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "")

    if (key && !process.env[key]) {
      process.env[key] = value
    }
  }
}

const app = express()
const server = http.createServer(app)

const io = new Server(server, {
  cors: { origin: "*" },
})

const apiKey = process.env.GEMINI_API_KEY
const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash"
const port = Number(process.env.PORT || 3001)
const teacherUsername = process.env.TEACHER_USERNAME || "docent"
const teacherPassword = process.env.TEACHER_PASSWORD || "les1234"
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null

const TEAM_COLORS = ["#ff8c42", "#3dd6d0", "#8f7cff", "#ff5d8f"]
const DEFAULT_TEAMS = ["Team Zon", "Team Oceaan"]

const hostSockets = new Set()
let players = []
let teams = createTeams(DEFAULT_TEAMS)
let questions = []
let currentQuestionIndex = -1
let answeredPlayers = new Set()
let roomCode = generateRoomCode()
let gameMeta = {
  topic: "",
  audience: "vmbo",
  questionCount: 12,
  status: "idle",
  generatedAt: null,
}

function generateRoomCode() {
  return Math.random().toString(36).slice(2, 7).toUpperCase()
}

function isHostSocket(socket) {
  return hostSockets.has(socket.id)
}

function requireHost(socket) {
  if (!isHostSocket(socket)) {
    socket.emit("host:error", { message: "Log eerst in als docent." })
    return false
  }

  return true
}

function buildFallbackSvg(prompt) {
  const safePrompt = String(prompt || "Lesson Battle").slice(0, 160)
  const escapedPrompt = safePrompt
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#10223b"/>
      <stop offset="50%" stop-color="#0d3b66"/>
      <stop offset="100%" stop-color="#ff7a59"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="720" rx="36" fill="url(#bg)"/>
  <circle cx="960" cy="150" r="120" fill="#ffffff18"/>
  <circle cx="240" cy="580" r="160" fill="#ffffff12"/>
  <rect x="90" y="90" width="1020" height="540" rx="28" fill="#07111fcc" stroke="#ffffff22"/>
  <text x="120" y="190" fill="#ffd49e" font-size="30" font-family="Arial, Helvetica, sans-serif" font-weight="700">Lesson Battle Visual</text>
  <text x="120" y="270" fill="#ffffff" font-size="48" font-family="Arial, Helvetica, sans-serif" font-weight="700">AI-afbeelding tijdelijk niet beschikbaar</text>
  <foreignObject x="120" y="320" width="920" height="220">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: Arial, Helvetica, sans-serif; color: #e7f1ff; font-size: 34px; line-height: 1.35;">
      ${escapedPrompt}
    </div>
  </foreignObject>
</svg>`
}

function createTeams(teamNames = DEFAULT_TEAMS) {
  const cleanedNames = teamNames
    .map((name) => String(name).trim())
    .filter(Boolean)
    .slice(0, 4)

  const uniqueNames = [...new Set(cleanedNames.length ? cleanedNames : DEFAULT_TEAMS)]

  return uniqueNames.map((name, index) => ({
    id: `team-${index + 1}`,
    name,
    color: TEAM_COLORS[index % TEAM_COLORS.length],
    score: 0,
  }))
}

function getCurrentQuestion() {
  return currentQuestionIndex >= 0 ? questions[currentQuestionIndex] ?? null : null
}

function extractJsonArray(text) {
  const cleaned = text.replace(/```json|```/gi, "").trim()
  const start = cleaned.indexOf("[")
  const end = cleaned.lastIndexOf("]")

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI antwoord bevat geen geldige JSON-array.")
  }

  return cleaned.slice(start, end + 1)
}

function normalizeQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error("AI gaf geen bruikbare vragen terug.")
  }

  return rawQuestions
    .map((question, index) => ({
      id: `q-${index + 1}`,
      prompt: String(question?.prompt ?? "").trim(),
      options: Array.isArray(question?.options)
        ? question.options.map((option) => String(option).trim()).slice(0, 4)
        : [],
      correctIndex: Number(question?.correctIndex),
      explanation: String(question?.explanation ?? "").trim(),
      category: String(question?.category ?? "").trim() || "Quiz",
      imagePrompt: String(question?.imagePrompt ?? "").trim(),
      imageAlt: String(question?.imageAlt ?? "").trim(),
    }))
    .filter(
      (question) =>
        question.prompt &&
        question.options.length === 4 &&
        question.options.every(Boolean) &&
        Number.isInteger(question.correctIndex) &&
        question.correctIndex >= 0 &&
        question.correctIndex < 4
    )
}

function shuffleArray(items) {
  const copy = [...items]

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]]
  }

  return copy
}

function hasRecentPattern(sequence, candidate) {
  const recent = sequence.slice(-2)

  if (recent.length === 2 && recent[0] === recent[1] && recent[1] === candidate) {
    return true
  }

  if (sequence.length >= 3) {
    const lastThree = sequence.slice(-3)
    const withCandidate = [...lastThree, candidate]

    if (withCandidate[0] === withCandidate[2] && withCandidate[1] === withCandidate[3]) {
      return true
    }
  }

  return false
}

function rebalanceQuestions(questionList) {
  const targetCounts = questionList.reduce(
    (counts, _, index) => {
      counts[index % 4] += 1
      return counts
    },
    [0, 0, 0, 0]
  )

  const usageCounts = [0, 0, 0, 0]
  const chosenSequence = []

  return questionList.map((question) => {
    const correctAnswer = question.options[question.correctIndex]
    const wrongAnswers = question.options.filter((_, index) => index !== question.correctIndex)
    const candidateIndices = shuffleArray([0, 1, 2, 3]).sort((left, right) => {
      const leftScore = usageCounts[left] - targetCounts[left]
      const rightScore = usageCounts[right] - targetCounts[right]
      return leftScore - rightScore
    })

    let chosenIndex =
      candidateIndices.find(
        (candidate) =>
          usageCounts[candidate] < targetCounts[candidate] && !hasRecentPattern(chosenSequence, candidate)
      ) ??
      candidateIndices.find((candidate) => !hasRecentPattern(chosenSequence, candidate)) ??
      candidateIndices[0]

    const nextOptions = []
    const wrongQueue = shuffleArray(wrongAnswers)

    for (let optionIndex = 0; optionIndex < 4; optionIndex += 1) {
      nextOptions.push(optionIndex === chosenIndex ? correctAnswer : wrongQueue.shift())
    }

    usageCounts[chosenIndex] += 1
    chosenSequence.push(chosenIndex)

    return {
      ...question,
      options: nextOptions,
      correctIndex: chosenIndex,
    }
  })
}

function sanitizeQuestionForClients(question) {
  if (!question) return null

  return {
    id: question.id,
    prompt: question.prompt,
    options: question.options,
    explanation: question.explanation,
    category: question.category,
    imagePrompt: question.imagePrompt,
    imageAlt: question.imageAlt || question.prompt,
  }
}

function getLeaderboard() {
  return [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

function syncTeamScores() {
  teams = teams.map((team) => ({
    ...team,
    score: players
      .filter((player) => player.teamId === team.id)
      .reduce((sum, player) => sum + player.score, 0),
  }))
}

function reassignPlayersToExistingTeams() {
  const fallbackTeamId = teams[0]?.id ?? "team-1"

  players = players.map((player) => ({
    ...player,
    teamId: teams.some((team) => team.id === player.teamId) ? player.teamId : fallbackTeamId,
  }))
}

function buildStatePayload() {
  syncTeamScores()

  return {
    players,
    teams,
    leaderboard: getLeaderboard(),
    game: {
      ...gameMeta,
      currentQuestionIndex,
      totalQuestions: questions.length,
      roomCodeActive: Boolean(roomCode),
      question: sanitizeQuestionForClients(getCurrentQuestion()),
    },
  }
}

function broadcastState() {
  const payload = buildStatePayload()
  io.emit("players:update", payload.players)
  io.emit("teams:update", payload.teams)
  io.emit("leaderboard:update", payload.leaderboard)
  io.emit("game:update", payload.game)
}

function buildFallbackQuestions({ topic, audience, questionCount }) {
  const safeQuestionCount = Math.max(6, Math.min(24, Number(questionCount) || 12))
  const cleanTopic = String(topic || "algemene kennis").trim()
  const category = cleanTopic.length > 40 ? "Gemixte quiz" : cleanTopic

  return Array.from({ length: safeQuestionCount }, (_, index) => {
    const number = index + 1
    const options = [
      `${cleanTopic} basisbegrip ${number}`,
      `${cleanTopic} voorbeeld ${number}`,
      `${cleanTopic} kernidee ${number}`,
      `${cleanTopic} toepassing ${number}`,
    ]

    return {
      id: `fallback-${number}`,
      prompt: `Welke optie past het best bij vraag ${number} over ${cleanTopic} voor ${audience || "leerlingen"}?`,
      options,
      correctIndex: number % 4,
      explanation: `Dit is een reservevraag omdat de AI-service niet direct antwoord gaf. Je kunt de ronde wel gewoon spelen.`,
      category,
      imagePrompt: `vibrant educational poster about ${cleanTopic}, classroom quiz, cinematic lighting, engaging students`,
      imageAlt: `Illustratie bij ${cleanTopic}`,
    }
  })
}

async function withTimeout(promise, ms) {
  let timeoutId

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("AI-generatie duurt te lang."))
    }, ms)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeoutId)
  }
}

async function generateQuestions({ topic, audience, questionCount }) {
  if (!genAI) {
    throw new Error("GEMINI_API_KEY ontbreekt in de serveromgeving.")
  }

  if (!topic?.trim()) {
    throw new Error("Voer eerst een onderwerp of thema in.")
  }

  const safeQuestionCount = Math.max(6, Math.min(24, Number(questionCount) || 12))
  const targetAudience = audience?.trim() || "vmbo"
  const model = genAI.getGenerativeModel({ model: modelName })

  const prompt = `
Maak precies ${safeQuestionCount} quizvragen in het Nederlands voor ${targetAudience}.

Thema of onderwerp:
${topic.trim()}

Belangrijke regels:
- Dit onderwerp mag elk domein zijn: schoolvakken, algemene kennis, geschiedenis, aardrijkskunde, talen, wetenschap, cultuur, sport of islamitische kennis.
- Bij religieuze of culturele onderwerpen: werk respectvol, feitelijk en zonder spot.
- Formuleer levendige maar duidelijke meerkeuzevragen.
- Elke vraag moet 4 antwoordopties hebben.
- Voeg per vraag een korte uitleg toe waarom het juiste antwoord klopt.
- Voeg per vraag ook een "imagePrompt" toe in het Engels, bedoeld voor een illustratieve AI-afbeelding die bij de vraag past.
- Voeg per vraag een korte "imageAlt" in het Nederlands toe.
- Gebruik afwisselende invalshoeken en houd het geschikt voor een klassikale quiz.

Antwoord alleen met geldige JSON. Geen markdown, geen codeblokken.

JSON-formaat:
[
  {
    "prompt": "vraag",
    "options": ["a", "b", "c", "d"],
    "correctIndex": 0,
    "explanation": "korte uitleg",
    "category": "bijvoorbeeld Rekenen",
    "imagePrompt": "cinematic classroom illustration of fractions on a neon board",
    "imageAlt": "Illustratie van de vraag"
  }
]
`

  const result = await model.generateContent(prompt)
  const text = result.response.text()
  const parsed = JSON.parse(extractJsonArray(text))
  const normalized = normalizeQuestions(parsed)

  if (normalized.length === 0) {
    throw new Error("AI output kon niet worden omgezet naar geldige vragen.")
  }

  return rebalanceQuestions(normalized)
}

app.get("/api/question-image", async (req, res) => {
  const prompt = String(req.query.prompt ?? "").trim()

  if (!prompt) {
    res.status(400).json({ error: "prompt is verplicht" })
    return
  }

  const searchParams = new URLSearchParams({
    width: "1200",
    height: "720",
    model: "flux",
    nologo: "true",
    enhance: "true",
  })

  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${searchParams.toString()}`

  try {
    const response = await fetch(imageUrl, {
      headers: {
        Accept: "image/*",
      },
    })

    if (!response.ok) {
      throw new Error(`Afbeelding ophalen mislukt met status ${response.status}`)
    }

    const contentType = response.headers.get("content-type") || "image/jpeg"
    const arrayBuffer = await response.arrayBuffer()

    res.setHeader("Content-Type", contentType)
    res.setHeader("Cache-Control", "public, max-age=3600")
    res.send(Buffer.from(arrayBuffer))
  } catch (error) {
    const message = error instanceof Error ? error.message : "Onbekende image-fout"
    console.error("Fout bij afbeelding proxy:", message)
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8")
    res.setHeader("Cache-Control", "public, max-age=300")
    res.status(200).send(buildFallbackSvg(prompt))
  }
})

if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath))

  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith("/socket.io")) {
      next()
      return
    }

    res.sendFile(path.join(clientDistPath, "index.html"))
  })
}

io.on("connection", (socket) => {
  console.log("player connected")
  socket.emit("state:init", buildStatePayload())

  socket.on("host:login", ({ username, password }) => {
    const cleanUsername = String(username ?? "").trim()
    const cleanPassword = String(password ?? "")

    if (cleanUsername !== teacherUsername || cleanPassword !== teacherPassword) {
      socket.emit("host:error", { message: "Onjuiste docentgegevens." })
      return
    }

    hostSockets.add(socket.id)
    socket.emit("host:login:success", {
      username: teacherUsername,
      roomCode,
    })
    socket.emit("host:generate:success", {
      count: questions.length,
    })
  })

  socket.on("host:configure", ({ teamNames }) => {
    if (!requireHost(socket)) return

    const nextTeams = Array.isArray(teamNames) ? teamNames : DEFAULT_TEAMS

    teams = createTeams(nextTeams)
    reassignPlayersToExistingTeams()
    broadcastState()
    socket.emit("host:room:update", { roomCode })
  })

  socket.on("host:room:refresh", () => {
    if (!requireHost(socket)) return

    roomCode = generateRoomCode()
    socket.emit("host:room:update", { roomCode })
    broadcastState()
  })

  socket.on("host:generate", async ({ topic, audience, questionCount, teamNames }) => {
    if (!requireHost(socket)) return

    console.log("host:generate ontvangen", {
      topic,
      audience,
      questionCount,
      teamCount: Array.isArray(teamNames) ? teamNames.length : 0,
    })

    try {
      socket.emit("host:generate:started", { message: "AI is bezig met de ronde..." })

      if (Array.isArray(teamNames) && teamNames.length > 0) {
        teams = createTeams(teamNames)
        reassignPlayersToExistingTeams()
      }

      roomCode = generateRoomCode()
      socket.emit("host:room:update", { roomCode })

      try {
        questions = await withTimeout(generateQuestions({ topic, audience, questionCount }), 25000)
      } catch (aiError) {
        const fallbackMessage = aiError instanceof Error ? aiError.message : "AI-fout"
        console.error("AI-generatie mislukt, fallback geactiveerd:", fallbackMessage)
        questions = buildFallbackQuestions({ topic, audience, questionCount })
        socket.emit("host:error", {
          message: `AI-generatie lukte niet direct. Er is een reservequiz gestart. Details: ${fallbackMessage}`,
        })
      }

      currentQuestionIndex = 0
      answeredPlayers = new Set()
      gameMeta = {
        topic: topic.trim(),
        audience: audience?.trim() || "vmbo",
        questionCount: questions.length,
        status: "live",
        generatedAt: new Date().toISOString(),
      }

      console.log(`vragen (${modelName}):`, questions.length)
      broadcastState()
      socket.emit("host:generate:success", { count: questions.length })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Onbekende serverfout."
      console.error("Fout bij vragen genereren:", message)
      socket.emit("host:error", { message })
    }
  })

  socket.on("host:next", () => {
    if (!requireHost(socket)) return

    if (currentQuestionIndex + 1 >= questions.length) {
      currentQuestionIndex = -1
      answeredPlayers = new Set()
      gameMeta = { ...gameMeta, status: questions.length ? "finished" : "idle" }
      broadcastState()
      return
    }

    currentQuestionIndex += 1
    answeredPlayers = new Set()
    broadcastState()
  })

  socket.on("host:reset", () => {
    if (!requireHost(socket)) return

    players = players.map((player) => ({ ...player, score: 0 }))
    questions = []
    currentQuestionIndex = -1
    answeredPlayers = new Set()
    roomCode = generateRoomCode()
    gameMeta = {
      topic: "",
      audience: "vmbo",
      questionCount: 12,
      status: "idle",
      generatedAt: null,
    }
    socket.emit("host:room:update", { roomCode })
    broadcastState()
  })

  socket.on("player:join", ({ name, teamId, roomCode: attemptedCode }) => {
    const trimmedName = String(name ?? "").trim()
    const selectedTeamId = teams.some((team) => team.id === teamId) ? teamId : teams[0]?.id
    const normalizedCode = String(attemptedCode ?? "").trim().toUpperCase()

    if (!trimmedName || !selectedTeamId) {
      socket.emit("player:error", { message: "Vul een naam in en kies een team." })
      return
    }

    if (!normalizedCode || normalizedCode !== roomCode) {
      socket.emit("player:error", { message: "De spelcode klopt niet." })
      return
    }

    const existingPlayer = players.find((player) => player.id === socket.id)

    if (existingPlayer) {
      existingPlayer.name = trimmedName
      existingPlayer.teamId = selectedTeamId
    } else {
      players.push({
        id: socket.id,
        name: trimmedName,
        teamId: selectedTeamId,
        score: 0,
      })
    }

    socket.emit("player:joined", { playerId: socket.id, teamId: selectedTeamId, roomCode })
    broadcastState()
  })

  socket.on("player:answer", ({ answer }) => {
    const question = getCurrentQuestion()
    const player = players.find((playerEntry) => playerEntry.id === socket.id)

    if (!question || !player) return
    if (answeredPlayers.has(socket.id)) return

    answeredPlayers.add(socket.id)

    const isCorrect = answer === question.correctIndex

    if (isCorrect) {
      player.score += 100
    }

    syncTeamScores()
    socket.emit("player:answer:result", {
      correct: isCorrect,
      correctIndex: question.correctIndex,
      explanation: question.explanation,
      playerScore: player.score,
      teamScore: teams.find((team) => team.id === player.teamId)?.score ?? 0,
    })
    broadcastState()
  })

  socket.on("disconnect", () => {
    hostSockets.delete(socket.id)
    players = players.filter((player) => player.id !== socket.id)
    answeredPlayers.delete(socket.id)
    broadcastState()
  })
})

server.listen(port, () => {
  console.log(`server draait op http://localhost:${port}`)
})
