import express from "express"
import fs from "fs"
import Groq from "groq-sdk"
import http from "http"
import OpenAI from "openai"
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
    if (key && !process.env[key]) process.env[key] = value
  }
}

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: "*" } })

const apiKey = process.env.GEMINI_API_KEY
const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash"
const groqApiKey = process.env.GROQ_API_KEY
const groqModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile"
const openAIApiKey = process.env.OPENAI_API_KEY
const openAIModel = process.env.OPENAI_MODEL || "gpt-4.1-mini"
const port = Number(process.env.PORT || 3001)
const teacherUsername = process.env.TEACHER_USERNAME || "docent"
const teacherPassword = process.env.TEACHER_PASSWORD || "les1234"
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null
const groq = groqApiKey ? new Groq({ apiKey: groqApiKey }) : null
const openAI = openAIApiKey ? new OpenAI({ apiKey: openAIApiKey }) : null

const TEAM_COLORS = ["#ff8c42", "#3dd6d0", "#8f7cff", "#ff5d8f"]
const DEFAULT_TEAMS = ["Team Zon", "Team Oceaan"]
const ROOM_HOST_GRACE_MS = 2 * 60 * 1000
const AI_PROVIDER_REQUEST_TIMEOUT_MS = 45000
const AI_PROVIDER_REPAIR_TIMEOUT_MS = 30000
const AI_ROUND_GENERATION_TIMEOUT_MS = 120000
const hostSocketIds = new Set()
const socketToRoom = new Map()
const rooms = new Map()

function generateRoomCode() {
  let code = ""
  do {
    code = Math.random().toString(36).slice(2, 7).toUpperCase()
  } while (rooms.has(code))
  return code
}

function escapeSvgText(value, maxLength = 160) {
  return String(value || "")
    .slice(0, maxLength)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function wrapSvgText(value, maxChars = 26, maxLines = 3) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean)
  const lines = []
  let current = ""

  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= maxChars) {
      current = next
      continue
    }
    if (current) lines.push(current)
    current = word
    if (lines.length === maxLines - 1) break
  }

  if (lines.length < maxLines && current) lines.push(current)
  return lines.slice(0, maxLines).map((line, index) => ({ line: escapeSvgText(line, 60), index }))
}

function isIslamicTopic(prompt, category) {
  return /(islam|koran|moskee|profeet|ramadan|hadith|dua|salah|gebed)/.test(`${prompt} ${category}`.toLowerCase())
}

function pickVisualTheme(prompt, category) {
  const source = `${prompt} ${category}`.toLowerCase()

  if (/(euro|prijs|korting|geld|koop|winkel|betaal|kost)/.test(source)) {
    return {
      gradient: ["#0f172a", "#134e4a", "#f59e0b"],
      accent: "#fde68a",
      icon: "price-tag",
      label: "Prijs en korting",
    }
  }
  if (/(breuk|procent|reken|wiskund|math|getal)/.test(source)) {
    return {
      gradient: ["#13293d", "#005f73", "#ee9b00"],
      accent: "#ffd166",
      icon: "pie",
      label: "Rekenen",
    }
  }
  if (/(aardrijkskunde|kaart|land|wereld|europa|planeet|geografie)/.test(source)) {
    return {
      gradient: ["#0b132b", "#1c2541", "#5bc0be"],
      accent: "#9bf6ff",
      icon: "globe",
      label: "Aardrijkskunde",
    }
  }
  if (/(geschiedenis|vroeger|romein|middeleeuw|oorlog|histor)/.test(source)) {
    return {
      gradient: ["#2d1e2f", "#5a3d2b", "#d98e04"],
      accent: "#ffd08a",
      icon: "column",
      label: "Geschiedenis",
    }
  }
  if (/(islam|koran|moskee|profeet|ramadan)/.test(source)) {
    return {
      gradient: ["#081c15", "#1b4332", "#2d6a4f"],
      accent: "#d8f3dc",
      icon: "crescent",
      label: "Islamitische kennis",
    }
  }
  if (/(engels|woord|taal|spelling|nederlands|grammatica)/.test(source)) {
    return {
      gradient: ["#1d3557", "#457b9d", "#a8dadc"],
      accent: "#f1faee",
      icon: "letters",
      label: "Taal",
    }
  }

  return {
    gradient: ["#10223b", "#0d3b66", "#ff7a59"],
    accent: "#ffd49e",
    icon: "spark",
    label: escapeSvgText(category || "Quiz", 40) || "Quiz",
  }
}

function buildIconMarkup(icon, accent) {
  switch (icon) {
    case "pie":
      return `
  <circle cx="930" cy="288" r="120" fill="#ffffff12" stroke="${accent}" stroke-width="8"/>
  <path d="M930 288 L930 168 A120 120 0 0 1 1034 348 Z" fill="${accent}" opacity="0.95"/>
  <circle cx="930" cy="288" r="52" fill="#0a1524"/>`
    case "price-tag":
      return `
  <path d="M820 210h170l88 88-176 176-126-126z" fill="#ffffff16" stroke="${accent}" stroke-width="8" stroke-linejoin="round"/>
  <circle cx="925" cy="265" r="18" fill="${accent}"/>
  <text x="845" y="380" fill="${accent}" font-size="118" font-family="Arial, Helvetica, sans-serif" font-weight="800">%</text>
  <text x="960" y="400" fill="#ffffff" font-size="110" font-family="Arial, Helvetica, sans-serif" font-weight="800">€</text>`
    case "globe":
      return `
  <circle cx="930" cy="288" r="124" fill="#ffffff10" stroke="${accent}" stroke-width="8"/>
  <ellipse cx="930" cy="288" rx="76" ry="124" fill="none" stroke="${accent}" stroke-width="6" opacity="0.75"/>
  <ellipse cx="930" cy="288" rx="124" ry="52" fill="none" stroke="${accent}" stroke-width="6" opacity="0.75"/>
  <path d="M808 288h244M930 164v248" stroke="${accent}" stroke-width="6" opacity="0.7"/>`
    case "column":
      return `
  <rect x="830" y="180" width="200" height="40" rx="12" fill="${accent}" opacity="0.92"/>
  <rect x="850" y="220" width="36" height="180" rx="10" fill="#ffffffd9"/>
  <rect x="912" y="220" width="36" height="180" rx="10" fill="#ffffffd9"/>
  <rect x="974" y="220" width="36" height="180" rx="10" fill="#ffffffd9"/>
  <rect x="820" y="400" width="220" height="34" rx="12" fill="${accent}" opacity="0.88"/>`
    case "crescent":
      return `
  <circle cx="930" cy="272" r="118" fill="${accent}" opacity="0.92"/>
  <circle cx="968" cy="252" r="108" fill="#0b1f17"/>
  <circle cx="1018" cy="340" r="14" fill="${accent}"/>
  <circle cx="995" cy="372" r="10" fill="${accent}" opacity="0.8"/>
  <circle cx="1042" cy="302" r="8" fill="${accent}" opacity="0.7"/>`
    case "letters":
      return `
  <rect x="806" y="154" width="248" height="268" rx="32" fill="#ffffff12" stroke="${accent}" stroke-width="6"/>
  <text x="850" y="262" fill="${accent}" font-size="110" font-family="Arial, Helvetica, sans-serif" font-weight="800">A</text>
  <text x="948" y="332" fill="#ffffff" font-size="120" font-family="Arial, Helvetica, sans-serif" font-weight="800">B</text>
  <text x="870" y="404" fill="${accent}" font-size="84" font-family="Arial, Helvetica, sans-serif" font-weight="700">C</text>`
    default:
      return `
  <circle cx="930" cy="288" r="120" fill="#ffffff10"/>
  <path d="M930 178l27 72 78 4-61 49 21 76-65-43-65 43 21-76-61-49 78-4z" fill="${accent}" opacity="0.95"/>`
  }
}

function buildQuestionSvg({ prompt, category }) {
  const theme = pickVisualTheme(prompt, category)
  const lines = wrapSvgText(prompt, 30, 2)
  const safeCategory = escapeSvgText(isIslamicTopic(prompt, category) ? "Islamitische kennis" : theme.label, 40)

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="${theme.gradient[0]}"/>
      <stop offset="52%" stop-color="${theme.gradient[1]}"/>
      <stop offset="100%" stop-color="${theme.gradient[2]}"/>
    </linearGradient>
    <linearGradient id="card" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#07111fdc"/>
      <stop offset="100%" stop-color="#0d1728a6"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="720" rx="36" fill="url(#bg)"/>
  <circle cx="210" cy="610" r="158" fill="#ffffff10"/>
  <circle cx="1080" cy="120" r="96" fill="#ffffff12"/>
  <rect x="72" y="72" width="1056" height="576" rx="34" fill="url(#card)" stroke="#ffffff20"/>
  <rect x="116" y="116" width="228" height="58" rx="29" fill="#ffffff10"/>
  <text x="148" y="153" fill="${theme.accent}" font-size="30" font-family="Arial, Helvetica, sans-serif" font-weight="700">${safeCategory}</text>
  <text x="118" y="228" fill="#ffffff" font-size="38" font-family="Arial, Helvetica, sans-serif" font-weight="800">Visuele hint</text>
  ${lines
    .map(
      ({ line, index }) =>
        `<text x="118" y="${292 + index * 46}" fill="#dcecff" font-size="30" font-family="Arial, Helvetica, sans-serif" font-weight="600">${line}</text>`
    )
    .join("\n  ")}
  <rect x="118" y="470" width="184" height="84" rx="24" fill="#ffffff10"/>
  <rect x="324" y="470" width="132" height="84" rx="24" fill="#ffffff0d"/>
  <rect x="478" y="470" width="118" height="84" rx="24" fill="#ffffff08"/>
  ${buildIconMarkup(theme.icon, theme.accent)}
</svg>`
}

function createTeams(teamNames = DEFAULT_TEAMS) {
  const cleanedNames = teamNames.map((name) => String(name).trim()).filter(Boolean).slice(0, 4)
  const uniqueNames = [...new Set(cleanedNames.length ? cleanedNames : DEFAULT_TEAMS)]
  return uniqueNames.map((name, index) => ({
    id: `team-${index + 1}`,
    name,
    color: TEAM_COLORS[index % TEAM_COLORS.length],
    score: 0,
  }))
}

function createRoom(hostSocketId) {
  const roomCode = generateRoomCode()
  const room = {
    code: roomCode,
    hostSocketId,
    hostOnline: true,
    players: [],
    teams: createTeams(),
    questions: [],
    currentQuestionIndex: -1,
    answeredPlayers: new Set(),
    playerAnswers: new Map(),
    closingTimeout: null,
    game: {
      topic: "",
      audience: "vmbo",
      questionCount: 12,
      questionDurationSec: 20,
      questionStartedAt: null,
      status: "idle",
      source: "idle",
      providerLabel: null,
      generatedAt: null,
    },
  }
  rooms.set(roomCode, room)
  socketToRoom.set(hostSocketId, roomCode)
  return room
}

function getRoomBySocketId(socketId) {
  const roomCode = socketToRoom.get(socketId)
  return roomCode ? rooms.get(roomCode) ?? null : null
}

function requireHostRoom(socket) {
  if (!hostSocketIds.has(socket.id)) {
    socket.emit("host:error", { message: "Log eerst in als docent." })
    return null
  }
  let room = getRoomBySocketId(socket.id)
  if (!room) room = createRoom(socket.id)
  return room
}

function currentQuestion(room) {
  return room.currentQuestionIndex >= 0 ? room.questions[room.currentQuestionIndex] ?? null : null
}

function sanitizeQuestion(question) {
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

function syncTeamScores(room) {
  room.teams = room.teams.map((team) => ({
    ...team,
    score: room.players.filter((player) => player.teamId === team.id).reduce((sum, player) => sum + player.score, 0),
  }))
}

function leaderboard(room) {
  return [...room.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

function reassignPlayersToExistingTeams(room) {
  const fallbackTeamId = room.teams[0]?.id ?? "team-1"
  room.players = room.players.map((player) => ({
    ...player,
    teamId: room.teams.some((team) => team.id === player.teamId) ? player.teamId : fallbackTeamId,
  }))
}

function buildStatePayload(room) {
  syncTeamScores(room)
  const answeredCount = room.answeredPlayers.size
  const totalPlayers = room.players.length
  return {
    players: room.players,
    teams: room.teams,
    leaderboard: leaderboard(room),
    game: {
      ...room.game,
      currentQuestionIndex: room.currentQuestionIndex,
      totalQuestions: room.questions.length,
      roomCodeActive: true,
      answeredCount,
      totalPlayers,
      allAnswered: totalPlayers > 0 && answeredCount >= totalPlayers,
      question: sanitizeQuestion(currentQuestion(room)),
    },
  }
}

function buildHostInsights(room) {
  const question = currentQuestion(room)
  const answeredCount = room.answeredPlayers.size
  const totalPlayers = room.players.length
  const allAnswered = totalPlayers > 0 && answeredCount >= totalPlayers

  return {
    questionId: question?.id ?? null,
    answeredCount,
    totalPlayers,
    allAnswered,
    canAdvance: Boolean(question) && allAnswered,
    correctIndex: allAnswered && question ? question.correctIndex : null,
    correctOption: allAnswered && question ? question.options[question.correctIndex] : null,
    explanation: allAnswered && question ? question.explanation : "",
    responses: room.players.map((player) => {
      const answer = room.playerAnswers.get(player.id)

      return {
        playerId: player.id,
        name: player.name,
        teamId: player.teamId,
        teamName: room.teams.find((team) => team.id === player.teamId)?.name || "",
        answered: Boolean(answer),
        answerIndex: allAnswered ? answer?.answerIndex ?? null : null,
        answerText: allAnswered && answer ? question?.options?.[answer.answerIndex] ?? null : null,
        isCorrect: allAnswered && answer ? answer.isCorrect : null,
      }
    }),
  }
}

function emitHostInsights(room) {
  if (!room?.hostSocketId) return
  io.to(room.hostSocketId).emit("host:question:insights", buildHostInsights(room))
}

function emitStateToRoom(room) {
  const payload = buildStatePayload(room)
  const recipients = [room.hostSocketId, ...room.players.map((player) => player.id)]
  for (const recipient of recipients) {
    io.to(recipient).emit("players:update", payload.players)
    io.to(recipient).emit("teams:update", payload.teams)
    io.to(recipient).emit("leaderboard:update", payload.leaderboard)
    io.to(recipient).emit("game:update", payload.game)
  }
  emitHostInsights(room)
}

function emitStateToSocket(socket, room) {
  const payload = room
    ? buildStatePayload(room)
    : {
        players: [],
        teams: createTeams(),
        leaderboard: [],
        game: {
          topic: "",
          audience: "vmbo",
          questionCount: 12,
          questionDurationSec: 20,
          questionStartedAt: null,
          status: "idle",
          source: "idle",
          providerLabel: null,
          generatedAt: null,
          currentQuestionIndex: -1,
          totalQuestions: 0,
          roomCodeActive: false,
          question: null,
        },
      }
  socket.emit("state:init", payload)
}

function stampQuestionStart(room) {
  room.game = { ...room.game, questionStartedAt: new Date().toISOString() }
}

function clearRoomClosingTimeout(room) {
  if (!room?.closingTimeout) return
  clearTimeout(room.closingTimeout)
  room.closingTimeout = null
}

function scheduleRoomClosure(room) {
  clearRoomClosingTimeout(room)
  room.hostOnline = false
  room.closingTimeout = setTimeout(() => {
    for (const player of room.players) {
      socketToRoom.delete(player.id)
      io.to(player.id).emit("player:error", { message: "Deze room is gesloten door de docent." })
    }
    rooms.delete(room.code)
  }, ROOM_HOST_GRACE_MS)
}

function claimRoomForHost(room, socketId) {
  clearRoomClosingTimeout(room)
  hostSocketIds.add(socketId)
  socketToRoom.set(socketId, room.code)
  room.hostSocketId = socketId
  room.hostOnline = true
}

function extractJsonArray(text) {
  const cleaned = text.replace(/```json|```/gi, "").trim()
  const start = cleaned.indexOf("[")
  const end = cleaned.lastIndexOf("]")
  if (start === -1 || end === -1 || end <= start) throw new Error("AI antwoord bevat geen geldige JSON-array.")
  return cleaned.slice(start, end + 1)
}

function normalizeQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) throw new Error("AI gaf geen bruikbare vragen terug.")
  return rawQuestions
    .map((question, index) => ({
      id: `q-${index + 1}`,
      prompt: String(question?.prompt ?? "").trim(),
      options: Array.isArray(question?.options) ? question.options.map((option) => String(option).trim()).slice(0, 4) : [],
      correctIndex: Number(question?.correctIndex),
      explanation: String(question?.explanation ?? "").trim(),
      category: String(question?.category ?? "").trim() || "Quiz",
      imagePrompt: String(question?.imagePrompt ?? "").trim(),
      imageAlt: String(question?.imageAlt ?? "").trim(),
    }))
    .filter((question) => question.prompt && question.options.length === 4 && question.options.every(Boolean) && Number.isInteger(question.correctIndex) && question.correctIndex >= 0 && question.correctIndex < 4)
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
  if (recent.length === 2 && recent[0] === recent[1] && recent[1] === candidate) return true
  if (sequence.length >= 3) {
    const lastThree = sequence.slice(-3)
    const withCandidate = [...lastThree, candidate]
    if (withCandidate[0] === withCandidate[2] && withCandidate[1] === withCandidate[3]) return true
  }
  return false
}

function rebalanceQuestions(questionList) {
  const targetCounts = questionList.reduce((counts, _, index) => {
    counts[index % 4] += 1
    return counts
  }, [0, 0, 0, 0])

  const usageCounts = [0, 0, 0, 0]
  const chosenSequence = []

  return questionList.map((question) => {
    const correctAnswer = question.options[question.correctIndex]
    const wrongAnswers = question.options.filter((_, index) => index !== question.correctIndex)
    const candidateIndices = shuffleArray([0, 1, 2, 3]).sort((left, right) => (usageCounts[left] - targetCounts[left]) - (usageCounts[right] - targetCounts[right]))
    const chosenIndex =
      candidateIndices.find((candidate) => usageCounts[candidate] < targetCounts[candidate] && !hasRecentPattern(chosenSequence, candidate)) ??
      candidateIndices.find((candidate) => !hasRecentPattern(chosenSequence, candidate)) ??
      candidateIndices[0]
    const wrongQueue = shuffleArray(wrongAnswers)
    const nextOptions = Array.from({ length: 4 }, (_, optionIndex) => (optionIndex === chosenIndex ? correctAnswer : wrongQueue.shift()))
    usageCounts[chosenIndex] += 1
    chosenSequence.push(chosenIndex)
    return { ...question, options: nextOptions, correctIndex: chosenIndex }
  })
}

function topicIncludes(topic, pattern) {
  return pattern.test(String(topic || "").toLowerCase())
}

function detectTopicDomain(topic) {
  const normalizedTopic = String(topic || "").toLowerCase()

  if (topicIncludes(normalizedTopic, /(klokkijken|klok|tijd aflezen|hele uren|halve uren|kwartier|kwartieren|minuten|digitale klok|analoge klok|rekenen met tijd)/)) return "tijd"
  if (topicIncludes(normalizedTopic, /(meten en maten|meten|maten|lengte|gewicht|inhoud|liter|milliliter|centimeter|meter|kilo|gram)/)) return "meten"
  if (topicIncludes(normalizedTopic, /(rekenen|wiskunde|breuk|procent|getal|optellen|aftrekken|delen|vermenigvuldigen)/)) return "rekenen"
  if (topicIncludes(normalizedTopic, /(taal|spelling|woordenschat|nederlands|engels|grammatica|lezen|schrijven)/)) return "taal"
  if (topicIncludes(normalizedTopic, /(aardrijkskunde|kaart|land|wereld|europa|geografie|hoofdstad)/)) return "aardrijkskunde"
  if (topicIncludes(normalizedTopic, /(geschiedenis|romeinen|middeleeuwen|oorlog|histor|bron)/)) return "geschiedenis"
  if (topicIncludes(normalizedTopic, /(biologie|lichaam|dieren|planten|natuur|gezondheid|orgaan)/)) return "biologie"
  if (topicIncludes(normalizedTopic, /(economie|geld|verzeker|sparen|bank|korting|prijs|ondernemen)/)) return "economie"
  if (topicIncludes(normalizedTopic, /(cultuur|religie|islam|koran|moskee|burgerschap|normen|waarden)/)) return "cultuur"
  return "general"
}

const DOMAIN_LABELS = {
  tijd: "Tijd en klokkijken",
  meten: "Meten en maten",
  rekenen: "Rekenen",
  taal: "Taal",
  aardrijkskunde: "Aardrijkskunde",
  geschiedenis: "Geschiedenis",
  biologie: "Biologie",
  economie: "Economie",
  cultuur: "Cultuur en samenleving",
  general: "Quiz",
}

const DOMAIN_KEYWORDS = {
  tijd: ["klok", "tijd", "kwartier", "minuten", "uur", "half", "digitale", "analoge"],
  meten: ["meter", "centimeter", "milliliter", "liter", "gram", "kilo", "lengte", "gewicht", "inhoud", "meten", "tijd"],
  rekenen: ["som", "getal", "breuk", "procent", "keer", "delen", "optellen", "aftrekken", "rekenen", "waarde"],
  taal: ["woord", "zin", "spelling", "betekent", "taal", "engels", "nederlands", "grammatica", "lezen"],
  aardrijkskunde: ["land", "werelddeel", "kaart", "hoofdstad", "zee", "rivier", "berg", "europa"],
  geschiedenis: ["verleden", "vroeger", "romeinen", "middeleeuwen", "oorlog", "bron", "historie"],
  biologie: ["lichaam", "hart", "longen", "plant", "dier", "skelet", "gezondheid", "orgaan"],
  economie: ["geld", "prijs", "korting", "bank", "rekening", "sparen", "verzekering", "euro"],
  cultuur: ["religie", "cultuur", "traditie", "respect", "museum", "moskee", "koran", "burgerschap"],
  general: [],
}

const TOPIC_STOPWORDS = new Set([
  "stel", "vragen", "over", "het", "de", "een", "en", "voor", "van", "op", "in", "aan", "vak", "thema", "onderwerp",
  "leerlingen", "leerling", "niveau", "doelgroep", "met", "bij", "tot", "algemeen",
])

function extractTopicKeywords(topic) {
  return [...new Set(
    String(topic || "")
      .toLowerCase()
      .replace(/[^a-z0-9à-ž\s-]/gi, " ")
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 4 && !TOPIC_STOPWORDS.has(word))
  )]
}

function questionTextBlob(question) {
  return [
    question.prompt,
    ...(question.options || []),
    question.explanation,
    question.category,
    question.imageAlt,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function questionMatchesTopic(question, topic, domain) {
  const text = questionTextBlob(question)
  const topicKeywords = extractTopicKeywords(topic)
  const domainKeywords = DOMAIN_KEYWORDS[domain] || []
  const topicHit = topicKeywords.some((keyword) => text.includes(keyword))
  const domainHit = domainKeywords.some((keyword) => text.includes(keyword))

  if (topicKeywords.length === 0) return domain === "general" ? true : domainHit
  return topicHit || domainHit
}

function validateQuestionFit(questions, topic) {
  const domain = detectTopicDomain(topic)
  const matches = questions.filter((question) => questionMatchesTopic(question, topic, domain)).length
  const matchRatio = questions.length ? matches / questions.length : 0
  return {
    domain,
    matches,
    matchRatio,
    isValid: domain === "general" ? matchRatio >= 0.35 : matchRatio >= 0.6,
  }
}

function sanitizeCategory(rawCategory, topic) {
  const domain = detectTopicDomain(topic || rawCategory)
  const fallbackLabel = DOMAIN_LABELS[domain] || "Quiz"
  const cleaned = String(rawCategory || "").trim()

  if (!cleaned) return fallbackLabel
  if (cleaned.length > 28) return fallbackLabel
  if (cleaned.toLowerCase() === String(topic || "").trim().toLowerCase()) return fallbackLabel
  if (cleaned.toLowerCase().startsWith("stel vragen")) return fallbackLabel
  return cleaned
}

function buildFallbackQuestions({ topic, questionCount }) {
  const normalizedTopic = String(topic || "").toLowerCase()
  const tijdBase = [
    ["Hoe laat is het een kwartier na 3?", ["03:15", "03:30", "03:45", "04:15"], 0, "Een kwartier na 3 is 03:15."],
    ["Hoeveel minuten zitten er in een uur?", ["30", "45", "60", "100"], 2, "Een uur heeft 60 minuten."],
    ["Wat betekent half 8?", ["07:30", "08:30", "07:00", "08:00"], 0, "Half 8 betekent 07:30."],
    ["Hoeveel kwartieren zitten er in een uur?", ["2", "3", "4", "6"], 2, "Een uur bestaat uit 4 kwartieren."],
    ["Welke tijd hoort bij 10 minuten voor 9?", ["08:50", "09:10", "08:10", "09:50"], 0, "10 minuten voor 9 is 08:50."],
    ["Hoe laat is het 20 minuten na 14:00?", ["14:10", "14:20", "14:30", "15:20"], 1, "20 minuten na 14:00 is 14:20."],
    ["Hoeveel minuten is een half uur?", ["15", "20", "30", "45"], 2, "Een half uur is 30 minuten."],
    ["Wat is eerder?", ["09:45", "10:15", "even laat", "niet te vergelijken"], 0, "09:45 is eerder dan 10:15."],
  ]
  const metenEnMatenBase = [
    ["Hoeveel centimeter is 1 meter?", ["10", "50", "100", "1000"], 2, "1 meter is 100 centimeter."],
    ["Wat is langer?", ["1 meter", "50 centimeter", "beide even lang", "dat weet je niet"], 0, "1 meter is langer dan 50 centimeter."],
    ["Waarmee meet je de lengte van een tafel?", ["Thermometer", "Liniaal of meetlint", "Weegschaal", "Klok"], 1, "Een liniaal of meetlint gebruik je om lengte te meten."],
    ["Hoeveel liter is een halve liter en nog een halve liter samen?", ["1 liter", "2 liter", "0,5 liter", "1,5 liter"], 0, "Een halve liter plus een halve liter is 1 liter."],
    ["Wat gebruik je om gewicht te meten?", ["Klok", "Weegschaal", "Kaart", "Rekenmachine"], 1, "Gewicht meet je met een weegschaal."],
    ["Hoeveel minuten zitten er in een kwartier?", ["10", "15", "20", "25"], 1, "Een kwartier is 15 minuten."],
    ["Wat is zwaarder?", ["1 kilo", "500 gram", "even zwaar", "niet te vergelijken"], 0, "1 kilo is zwaarder dan 500 gram."],
    ["Hoeveel milliliter is 1 liter?", ["100", "250", "500", "1000"], 3, "1 liter is 1000 milliliter."],
  ]
  const rekenenBase = [
    ["Welke breuk is gelijk aan 50%?", ["1/4", "1/2", "2/3", "3/4"], 1, "50% is hetzelfde als 1/2."],
    ["Hoeveel is 25% van 80?", ["10", "20", "25", "40"], 1, "25% van 80 is 20."],
    ["Wat is 7 x 8?", ["54", "56", "58", "64"], 1, "7 keer 8 is 56."],
    ["Welke waarde is het grootst?", ["0,8", "0,5", "0,75", "0,25"], 0, "0,8 is het grootste getal."],
    ["Hoeveel minuten zitten er in een half uur?", ["15", "20", "30", "45"], 2, "Een half uur is 30 minuten."],
  ]
  const taalBase = [
    ["Welk woord is juist gespeld?", ["gebeurt", "gebeurd", "gebeurtd", "gebuert"], 0, "De juiste spelling is 'gebeurt'."],
    ["Wat is het tegenovergestelde van 'groot'?", ["hoog", "klein", "breed", "lang"], 1, "'Klein' is het tegenovergestelde van 'groot'."],
    ["Welke zin is een vraagzin?", ["Ik loop naar school.", "Waar woon jij?", "Hij eet brood.", "Wij lezen een boek."], 1, "'Waar woon jij?' is een vraagzin."],
    ["Wat betekent het Engelse woord 'book'?", ["tafel", "boek", "school", "pen"], 1, "'Book' betekent 'boek'."],
  ]
  const aardrijkskundeBase = [
    ["Welke hoofdstad hoort bij Frankrijk?", ["Madrid", "Parijs", "Rome", "Berlijn"], 1, "Parijs is de hoofdstad van Frankrijk."],
    ["In welk werelddeel ligt Egypte?", ["Azië", "Europa", "Afrika", "Zuid-Amerika"], 2, "Egypte ligt in Afrika."],
    ["Wat is een kaart?", ["Een soort plant", "Een tekening van een gebied", "Een feest", "Een dier"], 1, "Een kaart is een tekening van een gebied."],
    ["Welke zee ligt aan Nederland?", ["Zwarte Zee", "Noordzee", "Middellandse Zee", "Rode Zee"], 1, "Nederland ligt aan de Noordzee."],
  ]
  const geschiedenisBase = [
    ["Wat bestudeert geschiedenis?", ["Planten", "Het verleden", "Sterren", "Getallen"], 1, "Geschiedenis gaat over het verleden."],
    ["Wat kwam eerder?", ["Middeleeuwen", "Tweede Wereldoorlog", "Vandaag", "Volgend jaar"], 0, "De Middeleeuwen kwamen veel eerder."],
    ["Wie bouwden veel aquaducten?", ["Romeinen", "Vikingen", "Egyptenaren", "Piraten"], 0, "De Romeinen bouwden veel aquaducten."],
    ["Wat is een bron in geschiedenis?", ["Alleen een boek", "Informatie uit of over het verleden", "Een rivier", "Een gebouw"], 1, "Een bron geeft informatie over het verleden."],
  ]
  const biologieBase = [
    ["Welk orgaan pompt bloed door je lichaam?", ["Long", "Hart", "Maag", "Lever"], 1, "Het hart pompt bloed rond."],
    ["Waarmee adem je vooral?", ["Nieren", "Longen", "Oren", "Spieren"], 1, "Je ademt met je longen."],
    ["Wat heeft een plant nodig om te groeien?", ["Water en licht", "Alleen zand", "Alleen wind", "Alleen schaduw"], 0, "Planten hebben water en licht nodig."],
    ["Tot welk deel van het lichaam behoren je botten?", ["Spierstelsel", "Zenuwstelsel", "Skelet", "Huid"], 2, "Botten vormen samen het skelet."],
  ]
  const economieBase = [
    ["Wat betekent sparen?", ["Alles direct uitgeven", "Geld bewaren voor later", "Geld lenen", "Geld weggooien"], 1, "Sparen is geld bewaren voor later."],
    ["Wat is korting?", ["Extra betalen", "Een lagere prijs", "Een belasting", "Een soort rekening"], 1, "Korting betekent dat de prijs lager wordt."],
    ["Waarvoor gebruik je een bankrekening?", ["Om op te koken", "Om geld te beheren", "Om te sporten", "Om huiswerk te maken"], 1, "Met een bankrekening beheer je geld."],
    ["Wat is duurder?", ["5 euro", "8 euro", "3 euro", "2 euro"], 1, "8 euro is het hoogste bedrag."],
  ]
  const cultuurBase = [
    ["Hoe heet het heilige boek van de islam?", ["Bijbel", "Thora", "Koran", "Psalmen"], 2, "De Koran is het heilige boek van de islam."],
    ["Wat betekent respect?", ["Iemand uitlachen", "Rekening houden met anderen", "Niet luisteren", "Ruzie maken"], 1, "Respect betekent dat je rekening houdt met anderen."],
    ["Wat doe je in een museum?", ["Sporten", "Kunst en geschiedenis bekijken", "Boodschappen doen", "Autorijden"], 1, "In een museum bekijk je vaak kunst en geschiedenis."],
    ["Wat is een traditie?", ["Iets dat mensen vaker op een bekende manier doen", "Een soort spelcomputer", "Alleen een liedje", "Een som"], 0, "Een traditie is iets dat vaker op een bekende manier terugkomt."],
  ]

  const base = [
    ["Wat is de grootste planeet van ons zonnestelsel?", ["Mars", "Aarde", "Jupiter", "Venus"], 2, "Jupiter is de grootste planeet van ons zonnestelsel."],
    ["Welke kleur krijg je door rood en geel te mengen?", ["Groen", "Oranje", "Paars", "Blauw"], 1, "Rood en geel samen geven oranje."],
    ["Hoeveel minuten zitten er in een uur?", ["30", "45", "60", "100"], 2, "Een uur heeft 60 minuten."],
    ["Welke breuk is gelijk aan 50%?", ["1/4", "1/2", "2/3", "3/4"], 1, "50% is hetzelfde als 1/2."],
    ["Hoe heet het heilige boek van de islam?", ["Bijbel", "Thora", "Koran", "Psalmen"], 2, "De Koran is het heilige boek van de islam."],
    ["Welke hoofdstad hoort bij Frankrijk?", ["Madrid", "Parijs", "Rome", "Berlijn"], 1, "Parijs is de hoofdstad van Frankrijk."],
  ]

  const selectedBase =
    topicIncludes(normalizedTopic, /(klokkijken|klok|tijd aflezen|hele uren|halve uren|kwartier|kwartieren|minuten|digitale klok|analoge klok|rekenen met tijd)/) ? tijdBase :
    topicIncludes(normalizedTopic, /(meten en maten|meten|maten|lengte|gewicht|inhoud|liter|milliliter|centimeter|meter|kilo|gram|tijd meten)/) ? metenEnMatenBase :
    topicIncludes(normalizedTopic, /(rekenen|wiskunde|breuk|procent|getal|geld|tijd)/) ? rekenenBase :
    topicIncludes(normalizedTopic, /(taal|spelling|woordenschat|nederlands|engels|grammatica|lezen)/) ? taalBase :
    topicIncludes(normalizedTopic, /(aardrijkskunde|kaart|land|wereld|europa|geografie)/) ? aardrijkskundeBase :
    topicIncludes(normalizedTopic, /(geschiedenis|romeinen|middeleeuwen|oorlog|histor)/) ? geschiedenisBase :
    topicIncludes(normalizedTopic, /(biologie|lichaam|dieren|planten|natuur|gezondheid)/) ? biologieBase :
    topicIncludes(normalizedTopic, /(economie|geld|verzeker|sparen|bank|korting|prijs)/) ? economieBase :
    topicIncludes(normalizedTopic, /(cultuur|religie|islam|koran|moskee|burgerschap|normen|waarden)/) ? cultuurBase :
    base

  const safeQuestionCount = Math.max(6, Math.min(24, Number(questionCount) || 12))
  const questions = Array.from({ length: safeQuestionCount }, (_, index) => {
    const [prompt, options, correctIndex, explanation] = selectedBase[index % selectedBase.length]
    return {
      id: `fallback-${index + 1}`,
      prompt,
      options,
      correctIndex,
      explanation,
      category: DOMAIN_LABELS[detectTopicDomain(topic)] || "Quiz",
      imagePrompt: `engaging classroom poster about ${topic || "general knowledge"}, educational quiz illustration, vibrant lighting`,
      imageAlt: `Illustratie bij ${topic || "de quiz"}`,
    }
  })

  return rebalanceQuestions(questions)
}

async function withTimeout(promise, ms) {
  let timeoutId
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("AI-generatie duurt te lang.")), ms)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeoutId)
  }
}

async function fetchWithTimeout(url, options, ms) {
  return withTimeout(fetch(url, options), ms)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildQuestionPrompt({ topic, audience, questionCount, extraRules = "" }) {
  return `
Maak precies ${questionCount} quizvragen in het Nederlands voor ${audience}.
Onderwerp:
${topic.trim()}

Regels:
- Analyseer eerst welk soort onderwerp dit is en maak inhoudelijk passende vragen.
- Pas taalniveau, moeilijkheid en context aan op de doelgroep.
- Als het onderwerp basisniveau vraagt, gebruik dan korte zinnen en concrete voorbeelden.
- Als het onderwerp specialistischer is, maak de vragen inhoudelijk preciezer maar nog steeds helder.
- Respectvol en feitelijk.
- 4 antwoordopties per vraag.
- Zorg dat er precies 1 duidelijk goed antwoord is.
- Vermijd te algemene placeholder-vragen die alleen het onderwerp herhalen.
- Korte uitleg per vraag.
- Voeg "category", "imagePrompt" en "imageAlt" toe.
- Bij islamitische kennis: geen gezichten, personen, profeten of levende wezens afbeelden; kies abstracte, objectgerichte of symbolische visuals.
- Geen markdown, alleen geldige JSON.
${extraRules}

Formaat:
[
  {
    "prompt": "vraag",
    "options": ["a", "b", "c", "d"],
    "correctIndex": 0,
    "explanation": "korte uitleg",
    "category": "categorie",
    "imagePrompt": "english image prompt",
    "imageAlt": "nederlandse alt"
  }
]
`
}

function buildRepairPrompt({ topic, audience, questionCount, brokenOutput, previousIssue }) {
  return `
Zet de onderstaande AI-output om naar exact geldige JSON voor een quiz.

Onderwerp: ${topic.trim()}
Doelgroep: ${audience}
Aantal vragen: ${questionCount}

Probleem dat hersteld moet worden:
${previousIssue}

Regels:
- Geef alleen een JSON-array terug.
- Zorg voor precies ${questionCount} objecten.
- Elk object moet bevatten: prompt, options, correctIndex, explanation, category, imagePrompt, imageAlt.
- options moet exact 4 items hebben.
- correctIndex moet 0, 1, 2 of 3 zijn.
- Verbeter waar nodig de inhoud zodat de vragen echt over het onderwerp gaan.
- Geen markdown en geen extra tekst.

Te herstellen output:
${String(brokenOutput || "").slice(0, 12000)}
`
}

async function requestGeminiText(prompt) {
  if (!genAI) throw new Error("Gemini is niet geconfigureerd.")
  const model = genAI.getGenerativeModel({ model: modelName })
  const result = await model.generateContent(prompt)
  return result.response.text()
}

async function requestOpenAIText(prompt) {
  if (!openAI) throw new Error("OpenAI is niet geconfigureerd.")
  const response = await openAI.responses.create({
    model: openAIModel,
    input: prompt,
  })
  return response.output_text || ""
}

async function requestGroqText(prompt) {
  if (!groq) throw new Error("Groq is niet geconfigureerd.")
  const completion = await groq.chat.completions.create({
    model: groqModel,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: "Je maakt quizvragen in helder Nederlands. Antwoord uitsluitend met geldige JSON.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  })

  return completion.choices?.[0]?.message?.content || ""
}

async function requestProviderText(provider, prompt, timeoutMs) {
  if (provider === "gemini") return withTimeout(requestGeminiText(prompt), timeoutMs)
  if (provider === "groq") return withTimeout(requestGroqText(prompt), timeoutMs)
  if (provider === "openai") return withTimeout(requestOpenAIText(prompt), timeoutMs)
  throw new Error(`Onbekende AI-provider: ${provider}`)
}

function normalizeQuestionsForTopic(rawQuestions, topic) {
  const normalized = normalizeQuestions(rawQuestions).map((question) => ({
    ...question,
    category: sanitizeCategory(question.category, topic),
  }))

  if (normalized.length === 0) {
    throw new Error("AI output kon niet worden omgezet naar geldige vragen.")
  }

  const fitCheck = validateQuestionFit(normalized, topic)
  if (!fitCheck.isValid) {
    throw new Error(`AI-vragen sloten te weinig aan op het onderwerp (${fitCheck.matches}/${normalized.length} passend).`)
  }

  return rebalanceQuestions(normalized)
}

function parseQuestionsFromText(text, topic) {
  const parsed = JSON.parse(extractJsonArray(text))
  return normalizeQuestionsForTopic(parsed, topic)
}

function retryDelaySecondsFromError(error) {
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : ""

  const retryMatch = rawMessage.match(/retry(?:\s+in)?\s+(\d+(?:\.\d+)?)s/i) || rawMessage.match(/"retryDelay":"(\d+)s"/i)
  return retryMatch?.[1] ? Math.max(1, Math.ceil(Number(retryMatch[1]))) : null
}

function formatProviderLabel(provider) {
  if (provider === "gemini") return "Gemini"
  if (provider === "groq") return "Groq"
  if (provider === "openai") return "OpenAI"
  return provider
}

async function generateQuestionsWithProvider(provider, { topic, audience, questionCount }) {
  const providerTimeoutMs = AI_PROVIDER_REQUEST_TIMEOUT_MS
  let lastError = null

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const extraRules =
      attempt === 1
        ? ""
        : "\n- Vorige poging was niet bruikbaar. Wees strenger op onderwerpstrouw, correcte JSON en exacte schema-volgorde."

    try {
      console.info(`[AI] ${provider} attempt ${attempt} gestart voor onderwerp: ${topic}`)
      const rawText = await requestProviderText(provider, buildQuestionPrompt({ topic, audience, questionCount, extraRules }), providerTimeoutMs)

      try {
        const questions = parseQuestionsFromText(rawText, topic)
        console.info(`[AI] ${provider} attempt ${attempt} geaccepteerd met ${questions.length} vragen`)
        return questions
      } catch (parseError) {
        lastError = parseError
        console.warn(`[AI] ${provider} attempt ${attempt} afgekeurd: ${parseError instanceof Error ? parseError.message : "onbekende parsefout"}`)

        try {
          const repairedText = await requestProviderText(
            provider,
            buildRepairPrompt({
              topic,
              audience,
              questionCount,
              brokenOutput: rawText,
              previousIssue: parseError instanceof Error ? parseError.message : "output was ongeldig",
            }),
            AI_PROVIDER_REPAIR_TIMEOUT_MS
          )
          const repairedQuestions = parseQuestionsFromText(repairedText, topic)
          console.info(`[AI] ${provider} repair-pass geslaagd`)
          return repairedQuestions
        } catch (repairError) {
          lastError = repairError
          console.warn(`[AI] ${provider} repair-pass mislukt: ${repairError instanceof Error ? repairError.message : "onbekende repairfout"}`)
        }
      }
    } catch (providerError) {
      lastError = providerError
      console.warn(`[AI] ${provider} attempt ${attempt} request-fout: ${providerError instanceof Error ? providerError.message : "onbekende providerfout"}`)
      const retrySeconds = retryDelaySecondsFromError(providerError)
      if (retrySeconds && retrySeconds <= 5 && attempt < 2) {
        await sleep(retrySeconds * 1000)
      }
    }
  }

  throw lastError ?? new Error(`${provider} kon geen bruikbare vragen genereren.`)
}

async function generateQuestionsWithGemini(topic, audience, questionCount) {
  return generateQuestionsWithProvider("gemini", { topic, audience, questionCount })
}

async function generateQuestionsWithGroq(topic, audience, questionCount) {
  return generateQuestionsWithProvider("groq", { topic, audience, questionCount })
}

async function generateQuestionsWithOpenAI(topic, audience, questionCount) {
  return generateQuestionsWithProvider("openai", { topic, audience, questionCount })
}

function formatGenerationError(error) {
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Onbekende AI-fout."

  if (/429 Too Many Requests|quota exceeded|rate limit/i.test(rawMessage)) {
    const retryMatch = rawMessage.match(/retry(?:\s+in)?\s+(\d+(?:\.\d+)?)s/i) || rawMessage.match(/"retryDelay":"(\d+)s"/i)
    const retrySeconds = retryMatch?.[1] ? Math.max(1, Math.ceil(Number(retryMatch[1]))) : null
    return retrySeconds
      ? `AI-limiet bereikt bij een AI-provider. Probeer over ${retrySeconds} seconden opnieuw.`
      : "AI-limiet bereikt bij een AI-provider. Probeer het over een paar minuten opnieuw."
  }

  if (/GEMINI_API_KEY ontbreekt|Groq is niet geconfigureerd|OpenAI is niet geconfigureerd/i.test(rawMessage)) {
    return "Een AI-provider is niet goed geconfigureerd op de server."
  }

  if (/geen passende vragen/i.test(rawMessage)) {
    return rawMessage
  }

  if (/geen geldige JSON|JSON-array|niet worden omgezet/i.test(rawMessage)) {
    return "De AI gaf geen bruikbare vragen terug. Probeer je onderwerp iets concreter te formuleren."
  }

  if (/AI-generatie duurt te lang/i.test(rawMessage)) {
    return "De AI reageert te traag voor deze ronde. Probeer het opnieuw of wacht heel even."
  }

  return `AI kon de ronde niet genereren. Details: ${rawMessage}`
}

async function generateQuestions({ topic, audience, questionCount }) {
  if (!genAI && !groq && !openAI) throw new Error("Er is geen AI-provider geconfigureerd op de server.")
  if (!topic?.trim()) throw new Error("Voer eerst een onderwerp of thema in.")

  const safeQuestionCount = Math.max(6, Math.min(24, Number(questionCount) || 12))
  const targetAudience = audience?.trim() || "vmbo"
  const attempts = [
    ...(genAI ? [{ name: "gemini", run: () => generateQuestionsWithGemini(topic, targetAudience, safeQuestionCount) }] : []),
    ...(groq ? [{ name: "groq", run: () => generateQuestionsWithGroq(topic, targetAudience, safeQuestionCount) }] : []),
    ...(openAI ? [{ name: "openai", run: () => generateQuestionsWithOpenAI(topic, targetAudience, safeQuestionCount) }] : []),
  ]

  const errors = []
  for (let index = 0; index < attempts.length; index += 1) {
    const provider = attempts[index]
    try {
      if (index > 0) {
        console.warn(`[AI] ${attempts[index - 1].name} gefaald, probeer ${provider.name} fallback.`)
      }
      const questions = await provider.run()
      return {
        questions,
        provider: provider.name,
        providerLabel: formatProviderLabel(provider.name),
      }
    } catch (providerError) {
      errors.push(`${provider.name}: ${providerError instanceof Error ? providerError.message : "onbekende fout"}`)
      console.warn(`[AI] provider ${provider.name} definitief afgekeurd`)
    }
  }

  throw new Error(errors.join(" | "))
}

app.get("/api/question-image", async (req, res) => {
  const prompt = String(req.query.prompt ?? "").trim()
  const category = String(req.query.category ?? "").trim()
  if (!prompt) {
    res.status(400).json({ error: "prompt is verplicht" })
    return
  }
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8")
  res.setHeader("Cache-Control", "public, max-age=3600")
  res.status(200).send(buildQuestionSvg({ prompt, category }))
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
  emitStateToSocket(socket, getRoomBySocketId(socket.id))

  socket.on("host:login", ({ username, password, roomCode }) => {
    if (String(username ?? "").trim() !== teacherUsername || String(password ?? "") !== teacherPassword) {
      socket.emit("host:error", { message: "Onjuiste docentgegevens." })
      return
    }

    const requestedCode = String(roomCode ?? "").trim().toUpperCase()
    const reclaimableRoom = requestedCode ? rooms.get(requestedCode) : null
    const room = reclaimableRoom ?? getRoomBySocketId(socket.id) ?? createRoom(socket.id)
    claimRoomForHost(room, socket.id)
    socket.emit("host:login:success", { username: teacherUsername, roomCode: room.code })
    socket.emit("host:room:update", { roomCode: room.code })
    socket.emit("host:generate:success", {
      count: room.questions.length,
      provider: room.game.source || null,
      providerLabel: room.game.providerLabel || null,
    })
    emitStateToRoom(room)
    emitStateToSocket(socket, room)
  })

  socket.on("player:lookup-room", ({ roomCode }) => {
    const room = rooms.get(String(roomCode ?? "").trim().toUpperCase())
    if (!room) {
      socket.emit("player:room:preview", { valid: false })
      return
    }

    socket.emit("player:room:preview", {
      valid: true,
      roomCode: room.code,
      teams: room.teams,
      status: room.game.status,
    })
  })

  socket.on("host:configure", ({ teamNames }) => {
    const room = requireHostRoom(socket)
    if (!room) return
    room.teams = createTeams(Array.isArray(teamNames) ? teamNames : DEFAULT_TEAMS)
    reassignPlayersToExistingTeams(room)
    emitStateToRoom(room)
    socket.emit("host:configure:success", {
      teams: room.teams,
    })
  })

  socket.on("host:room:refresh", () => {
    const room = requireHostRoom(socket)
    if (!room) return

    clearRoomClosingTimeout(room)
    rooms.delete(room.code)
    room.code = generateRoomCode()
    rooms.set(room.code, room)
    socketToRoom.set(room.hostSocketId, room.code)

    for (const player of room.players) {
      socketToRoom.delete(player.id)
      io.to(player.id).emit("player:error", { message: "De spelcode is vernieuwd. Voer de nieuwe code in." })
    }

    room.players = []
    room.answeredPlayers = new Set()
    room.playerAnswers = new Map()
    socket.emit("host:room:update", { roomCode: room.code })
    emitStateToRoom(room)
  })

  socket.on("host:generate", async ({ topic, audience, questionCount, teamNames, questionDurationSec }) => {
    const room = requireHostRoom(socket)
    if (!room) return

    const safeDuration = Math.max(8, Math.min(60, Number(questionDurationSec) || 20))
    socket.emit("host:generate:started", { message: "AI is bezig met de ronde..." })

    if (Array.isArray(teamNames) && teamNames.length > 0) {
      room.teams = createTeams(teamNames)
      reassignPlayersToExistingTeams(room)
    }

    let generationResult
    try {
      generationResult = await withTimeout(
        generateQuestions({ topic, audience, questionCount }),
        AI_ROUND_GENERATION_TIMEOUT_MS
      )
      room.questions = generationResult.questions
      console.info(
        `[AI] ronde voor room ${room.code} gegenereerd via ${generationResult.providerLabel}`
      )
    } catch (aiError) {
      const fullErrorMessage = aiError instanceof Error ? aiError.message : "AI-fout"
      const userMessage = formatGenerationError(aiError)
      console.error("AI generatie mislukt:", fullErrorMessage)
      room.questions = []
      room.currentQuestionIndex = -1
      room.answeredPlayers = new Set()
      room.playerAnswers = new Map()
      room.game = {
        topic: String(topic ?? "").trim(),
        audience: audience?.trim() || "vmbo",
        questionCount: Number(questionCount) || 12,
        questionDurationSec: safeDuration,
        questionStartedAt: null,
        status: "idle",
        source: "idle",
        providerLabel: null,
        generatedAt: null,
      }
      emitStateToRoom(room)
      socket.emit("host:error", { message: userMessage })
      return
    }

    room.currentQuestionIndex = 0
    room.answeredPlayers = new Set()
    room.playerAnswers = new Map()
    room.game = {
      topic: String(topic ?? "").trim(),
      audience: audience?.trim() || "vmbo",
      questionCount: room.questions.length,
      questionDurationSec: safeDuration,
      questionStartedAt: new Date().toISOString(),
      status: "live",
      source: generationResult?.provider || "ai",
      providerLabel: generationResult?.providerLabel || "AI",
      generatedAt: new Date().toISOString(),
    }

    emitStateToRoom(room)
    socket.emit("host:generate:success", {
      count: room.questions.length,
      provider: generationResult?.provider || null,
      providerLabel: generationResult?.providerLabel || null,
    })
  })

  socket.on("host:next", () => {
    const room = requireHostRoom(socket)
    if (!room) return

    if (room.currentQuestionIndex + 1 >= room.questions.length) {
      room.currentQuestionIndex = -1
      room.answeredPlayers = new Set()
      room.playerAnswers = new Map()
      room.game = { ...room.game, status: room.questions.length ? "finished" : "idle", questionStartedAt: null }
      emitStateToRoom(room)
      return
    }

    room.currentQuestionIndex += 1
    room.answeredPlayers = new Set()
    room.playerAnswers = new Map()
    stampQuestionStart(room)
    emitStateToRoom(room)
  })

  socket.on("host:reset", () => {
    const room = requireHostRoom(socket)
    if (!room) return

    room.players = room.players.map((player) => ({ ...player, score: 0 }))
    room.questions = []
    room.currentQuestionIndex = -1
    room.answeredPlayers = new Set()
    room.playerAnswers = new Map()
    room.game = {
      topic: "",
      audience: "vmbo",
      questionCount: 12,
      questionDurationSec: 20,
      questionStartedAt: null,
      status: "idle",
      source: "idle",
      providerLabel: null,
      generatedAt: null,
    }
    emitStateToRoom(room)
  })

  socket.on("host:remove-player", ({ playerId }) => {
    const room = requireHostRoom(socket)
    if (!room) return

    const playerToRemove = room.players.find((player) => player.id === playerId)
    if (!playerToRemove) return

    room.players = room.players.filter((player) => player.id !== playerId)
    room.answeredPlayers.delete(playerId)
    room.playerAnswers.delete(playerId)
    socketToRoom.delete(playerId)

    io.to(playerId).emit("player:removed", {
      message: "Je bent verwijderd door de beheerder. Je kunt opnieuw deelnemen met de spelcode.",
    })

    emitStateToRoom(room)
  })

  socket.on("player:join", ({ name, teamId, roomCode }) => {
    const room = rooms.get(String(roomCode ?? "").trim().toUpperCase())
    if (!room) {
      socket.emit("player:error", { message: "De spelcode klopt niet." })
      return
    }
    if (!room.hostOnline) {
      socket.emit("player:error", { message: "De docent is tijdelijk offline. Probeer over een paar seconden opnieuw." })
      return
    }

    const trimmedName = String(name ?? "").trim()
    const selectedTeamId = room.teams.some((team) => team.id === teamId) ? teamId : room.teams[0]?.id
    if (!trimmedName || !selectedTeamId) {
      socket.emit("player:error", { message: "Vul een naam in en kies een team." })
      return
    }

    const previousRoomCode = socketToRoom.get(socket.id)
    if (previousRoomCode && previousRoomCode !== room.code) {
      const previousRoom = rooms.get(previousRoomCode)
      if (previousRoom) {
        previousRoom.players = previousRoom.players.filter((player) => player.id !== socket.id)
        previousRoom.answeredPlayers.delete(socket.id)
        previousRoom.playerAnswers.delete(socket.id)
        emitStateToRoom(previousRoom)
      }
    }

    socketToRoom.set(socket.id, room.code)
    const existingPlayer = room.players.find((player) => player.id === socket.id)
    if (existingPlayer) {
      existingPlayer.name = trimmedName
      existingPlayer.teamId = selectedTeamId
    } else {
      room.players.push({ id: socket.id, name: trimmedName, teamId: selectedTeamId, score: 0 })
    }

    socket.emit("player:joined", { playerId: socket.id, teamId: selectedTeamId, roomCode: room.code })
    emitStateToSocket(socket, room)
    emitStateToRoom(room)
  })

  socket.on("player:answer", ({ answer }) => {
    const room = getRoomBySocketId(socket.id)
    if (!room) return
    const question = currentQuestion(room)
    const player = room.players.find((entry) => entry.id === socket.id)
    if (!question || !player || room.answeredPlayers.has(socket.id)) return

    const startTime = room.game.questionStartedAt ? new Date(room.game.questionStartedAt).getTime() : 0
    const withinAnswerWindow = startTime && Date.now() <= startTime + room.game.questionDurationSec * 1000
    if (!withinAnswerWindow) return

    room.answeredPlayers.add(socket.id)
    const isCorrect = answer === question.correctIndex
    room.playerAnswers.set(socket.id, {
      answerIndex: answer,
      isCorrect,
    })
    if (isCorrect) player.score += 100

    syncTeamScores(room)
    socket.emit("player:answer:result", {
      correct: isCorrect,
      correctIndex: question.correctIndex,
      explanation: question.explanation,
      playerScore: player.score,
      teamScore: room.teams.find((team) => team.id === player.teamId)?.score ?? 0,
    })
    emitStateToRoom(room)
  })

  socket.on("disconnect", () => {
    const room = getRoomBySocketId(socket.id)
    hostSocketIds.delete(socket.id)
    socketToRoom.delete(socket.id)
    if (!room) return

    if (room.hostSocketId === socket.id) {
      scheduleRoomClosure(room)
      emitStateToRoom(room)
      return
    }

    room.players = room.players.filter((player) => player.id !== socket.id)
    room.answeredPlayers.delete(socket.id)
    room.playerAnswers.delete(socket.id)
    emitStateToRoom(room)
  })
})

server.listen(port, () => {
  console.log(`server draait op http://localhost:${port}`)
})
