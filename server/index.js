import express from "express"
import fs from "fs"
import Groq from "groq-sdk"
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
const groqApiKey = process.env.GROQ_API_KEY
const groqModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile"
const port = Number(process.env.PORT || 3001)
const teacherUsername = process.env.TEACHER_USERNAME || "docent"
const teacherPassword = process.env.TEACHER_PASSWORD || "les1234"
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null
const groq = groqApiKey ? new Groq({ apiKey: groqApiKey }) : null

const TEAM_COLORS = ["#ff8c42", "#3dd6d0", "#8f7cff", "#ff5d8f"]
const DEFAULT_TEAMS = ["Team Zon", "Team Oceaan"]
const QUESTION_BATCH_SIZE = 50
const QUESTION_POOL_LOW_WATERMARK = 10
const QUESTION_GENERATION_TIMEOUT_MS = 120000

const hostSockets = new Set()
let players = []
let teams = createTeams(DEFAULT_TEAMS)
let questions = []
let questionsPerTopic = {}
let topicGenerationPromises = {}
let currentQuestionIndex = -1
let answeredPlayers = new Set()
let roomCode = generateRoomCode()
let gameMeta = {
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

function stampQuestionStart() {
  gameMeta = {
    ...gameMeta,
    questionStartedAt: new Date().toISOString(),
  }
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

function normalizeTopicKey(topic) {
  return String(topic ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
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

function repairJsonArrayText(jsonText) {
  return jsonText
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
}

function parseQuestionsFromAiText(text) {
  const extracted = extractJsonArray(text)

  try {
    return JSON.parse(extracted)
  } catch (parseError) {
    const repaired = repairJsonArrayText(extracted)

    if (repaired !== extracted) {
      try {
        console.warn("AI JSON was ongeldig, lokale repair-pass toegepast.")
        return JSON.parse(repaired)
      } catch {
        // Fall through to the original error below.
      }
    }

    const message = parseError instanceof Error ? parseError.message : "Onbekende JSON-fout"
    throw new Error(`AI antwoord bevat ongeldige JSON: ${message}`)
  }
}

function normalizeQuestion(question, index, batchId) {
  const prompt = String(question?.prompt ?? question?.question ?? question?.vraag ?? "").trim()
  const rawOptions = Array.isArray(question?.options)
    ? question.options
    : Array.isArray(question?.answers)
      ? question.answers
      : Array.isArray(question?.antwoordopties)
        ? question.antwoordopties
        : []
  const options = rawOptions.map((option) => String(option).trim()).filter(Boolean).slice(0, 4)

  let correctIndex = Number(
    question?.correctIndex ?? question?.answerIndex ?? question?.correctAnswerIndex ?? question?.juisteIndex
  )

  if (!Number.isInteger(correctIndex) && typeof question?.correctAnswer === "string") {
    const normalizedCorrectAnswer = question.correctAnswer.trim().toLowerCase()
    correctIndex = options.findIndex((option) => option.toLowerCase() === normalizedCorrectAnswer)
  }

  const normalized = {
    id: `q-${batchId}-${index + 1}`,
    prompt,
    options,
    correctIndex,
    explanation: String(question?.explanation ?? question?.uitleg ?? "").trim(),
    category: String(question?.category ?? question?.onderwerp ?? "").trim() || "Quiz",
    imagePrompt: String(question?.imagePrompt ?? question?.visualPrompt ?? "").trim(),
    imageAlt: String(question?.imageAlt ?? "").trim(),
  }

  if (!normalized.prompt) {
    return { ok: false, reason: "ontbrekende prompt" }
  }

  if (normalized.options.length < 4) {
    return { ok: false, reason: "minder dan 4 antwoordopties" }
  }

  if (!Number.isInteger(normalized.correctIndex) || normalized.correctIndex < 0 || normalized.correctIndex >= 4) {
    return { ok: false, reason: "ongeldige correctIndex" }
  }

  return { ok: true, question: normalized }
}

function normalizeQuestions(rawQuestions, { minimumCount = 1 } = {}) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error("AI gaf geen bruikbare vragen terug.")
  }

  const batchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const acceptedQuestions = []
  const rejectionReasons = new Map()

  rawQuestions.forEach((question, index) => {
    const normalized = normalizeQuestion(question, index, batchId)

    if (!normalized.ok) {
      rejectionReasons.set(normalized.reason, (rejectionReasons.get(normalized.reason) ?? 0) + 1)
      return
    }

    acceptedQuestions.push(normalized.question)
  })

  if (rejectionReasons.size > 0) {
    console.warn(
      "AI-validatie: vragen afgekeurd",
      Object.fromEntries(rejectionReasons.entries())
    )
  }

  if (acceptedQuestions.length < minimumCount) {
    throw new Error(
      `AI gaf te weinig geldige vragen terug (${acceptedQuestions.length}/${minimumCount}).`
    )
  }

  return acceptedQuestions
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

function buildFractionPercentFallbackQuestions() {
  return [
    {
      prompt: "Welke breuk is gelijk aan 50%?",
      options: ["1/4", "1/2", "2/3", "3/4"],
      correctIndex: 1,
      explanation: "50% betekent 50 van de 100, en dat is hetzelfde als 1/2.",
    },
    {
      prompt: "Wat is 25% van 80?",
      options: ["10", "20", "25", "40"],
      correctIndex: 1,
      explanation: "25% is een kwart. Een kwart van 80 is 20.",
    },
    {
      prompt: "Welke breuk hoort bij 75%?",
      options: ["1/3", "2/3", "3/4", "4/5"],
      correctIndex: 2,
      explanation: "75% = 75/100 = 3/4.",
    },
    {
      prompt: "Wat is 10% van 230?",
      options: ["2,3", "23", "32", "46"],
      correctIndex: 1,
      explanation: "10% is delen door 10. 230 gedeeld door 10 is 23.",
    },
    {
      prompt: "Welke breuk is het grootst?",
      options: ["1/2", "2/5", "3/8", "4/9"],
      correctIndex: 0,
      explanation: "1/2 = 0,5 en dat is groter dan 0,4, 0,375 en ongeveer 0,44.",
    },
    {
      prompt: "Een trui kost eerst 60 euro en daarna 20% minder. Wat is de nieuwe prijs?",
      options: ["48 euro", "50 euro", "52 euro", "54 euro"],
      correctIndex: 0,
      explanation: "20% van 60 is 12. 60 - 12 = 48 euro.",
    },
    {
      prompt: "Welke breuk is gelijk aan 0,2?",
      options: ["1/2", "1/4", "1/5", "2/5"],
      correctIndex: 2,
      explanation: "1/5 = 0,2.",
    },
    {
      prompt: "Wat is 40% van 150?",
      options: ["45", "50", "60", "75"],
      correctIndex: 2,
      explanation: "10% van 150 is 15, dus 40% is 4 x 15 = 60.",
    },
    {
      prompt: "Welke procent hoort bij 3/5?",
      options: ["30%", "40%", "50%", "60%"],
      correctIndex: 3,
      explanation: "3/5 = 0,6 = 60%.",
    },
    {
      prompt: "Een pizza is in 8 gelijke stukken verdeeld. Je eet 2 stukken op. Welk percentage is dat?",
      options: ["20%", "25%", "30%", "40%"],
      correctIndex: 1,
      explanation: "2 van de 8 stukken is 2/8 = 1/4 = 25%.",
    },
    {
      prompt: "Wat is 5% van 200?",
      options: ["5", "10", "15", "20"],
      correctIndex: 1,
      explanation: "10% van 200 is 20, dus 5% is de helft daarvan: 10.",
    },
    {
      prompt: "Welke breuk is gelijk aan 20%?",
      options: ["1/3", "1/4", "1/5", "2/5"],
      correctIndex: 2,
      explanation: "20% = 20/100 = 1/5.",
    },
  ]
}

function buildGeographyFallbackQuestions() {
  return [
    { prompt: "Welke hoofdstad hoort bij Frankrijk?", options: ["Madrid", "Parijs", "Rome", "Berlijn"], correctIndex: 1, explanation: "Parijs is de hoofdstad van Frankrijk." },
    { prompt: "Op welk werelddeel ligt Egypte grotendeels?", options: ["Azië", "Europa", "Afrika", "Zuid-Amerika"], correctIndex: 2, explanation: "Egypte ligt grotendeels in Afrika." },
    { prompt: "Hoe noem je een kaart die vooral hoogteverschillen laat zien?", options: ["Klimaatkaart", "Topografische kaart", "Bevolkingskaart", "Themakaart"], correctIndex: 1, explanation: "Een topografische kaart laat onder meer reliëf en hoogte zien." },
    { prompt: "Wat is een delta?", options: ["Een gebergte", "Een woestijn", "Een gebied waar een rivier zich splitst bij zee", "Een groot meer"], correctIndex: 2, explanation: "Bij een delta splitst een rivier zich in meerdere armen richting zee." },
    { prompt: "Welke lijn verdeelt de aarde in een noordelijk en zuidelijk halfrond?", options: ["Kreeftskeerkring", "Evenaar", "Nulmeridiaan", "Poolcirkel"], correctIndex: 1, explanation: "De evenaar verdeelt de aarde in twee halfronden." },
    { prompt: "Wat betekent bevolkingsdichtheid?", options: ["Het aantal geboorten per jaar", "Het aantal inwoners per km²", "Het aantal steden in een land", "De gemiddelde leeftijd"], correctIndex: 1, explanation: "Bevolkingsdichtheid is het aantal inwoners per vierkante kilometer." },
  ]
}

function buildHistoryFallbackQuestions() {
  return [
    { prompt: "In welke periode leefden ridders en kastelen vooral?", options: ["Middeleeuwen", "Oudheid", "Prehistorie", "Tijd van ontdekkers"], correctIndex: 0, explanation: "Ridders en kastelen horen vooral bij de middeleeuwen." },
    { prompt: "Wie was de eerste president van de Verenigde Staten?", options: ["Abraham Lincoln", "George Washington", "Thomas Jefferson", "John Adams"], correctIndex: 1, explanation: "George Washington was de eerste president." },
    { prompt: "Wat was de industriële revolutie?", options: ["Een oorlog tussen landen", "Een tijd van veel machinegebruik en fabrieken", "Een religieuze hervorming", "Een ontdekkingsreis"], correctIndex: 1, explanation: "De industriële revolutie draaide om machines, fabrieken en grote veranderingen in werk." },
    { prompt: "Waarvoor werd de Berlijnse Muur een symbool?", options: ["De Gouden Eeuw", "De Koude Oorlog", "De middeleeuwen", "De Romeinse tijd"], correctIndex: 1, explanation: "De Berlijnse Muur werd een belangrijk symbool van de Koude Oorlog." },
    { prompt: "Welke beschaving bouwde piramides?", options: ["De Grieken", "De Romeinen", "De Egyptenaren", "De Vikingen"], correctIndex: 2, explanation: "De Egyptenaren bouwden de bekende piramides." },
    { prompt: "Wat betekent chronologisch werken?", options: ["Van belangrijkste naar minst belangrijke", "Van vroeger naar later in de tijd", "Van dichtbij naar ver weg", "Van makkelijk naar moeilijk"], correctIndex: 1, explanation: "Chronologisch betekent op tijdsvolgorde." },
  ]
}

function buildBiologyFallbackQuestions() {
  return [
    { prompt: "Welk orgaan pompt bloed door je lichaam?", options: ["Long", "Lever", "Hart", "Maag"], correctIndex: 2, explanation: "Het hart pompt bloed door het lichaam." },
    { prompt: "Wat hebben planten nodig voor fotosynthese?", options: ["Zonlicht, water en koolstofdioxide", "Alleen water", "Alleen zuurstof", "Zout en zand"], correctIndex: 0, explanation: "Voor fotosynthese gebruiken planten zonlicht, water en koolstofdioxide." },
    { prompt: "Welk deel van een cel bevat meestal het erfelijk materiaal?", options: ["Celwand", "Celkern", "Bladgroenkorrel", "Vacuole"], correctIndex: 1, explanation: "De celkern bevat meestal het DNA." },
    { prompt: "Hoe noem je dieren die planten eten?", options: ["Roofdieren", "Omnivoren", "Herbivoren", "Carnivoren"], correctIndex: 2, explanation: "Herbivoren zijn planteneters." },
    { prompt: "Waar vindt gaswisseling vooral plaats in je longen?", options: ["In de luchtpijp", "In de longblaasjes", "In de ribben", "In de keel"], correctIndex: 1, explanation: "Gaswisseling gebeurt vooral in de longblaasjes." },
    { prompt: "Wat is de functie van wortels bij een plant?", options: ["Licht opnemen", "Water en mineralen opnemen", "Zaden verspreiden", "Bloemen maken"], correctIndex: 1, explanation: "Wortels nemen water en mineralen uit de bodem op." },
  ]
}

function buildEnglishFallbackQuestions() {
  return [
    { prompt: "Wat betekent het Engelse woord 'library'?", options: ["Boek", "School", "Bibliotheek", "Klaslokaal"], correctIndex: 2, explanation: "'Library' betekent bibliotheek." },
    { prompt: "Welke zin is grammaticaal correct?", options: ["He go to school every day.", "He goes to school every day.", "He going to school every day.", "He gone to school every day."], correctIndex: 1, explanation: "Bij 'he' hoort in de tegenwoordige tijd meestal een werkwoord met -s." },
    { prompt: "Wat is de vertaling van 'because'?", options: ["Maar", "Omdat", "Daarna", "Misschien"], correctIndex: 1, explanation: "'Because' betekent 'omdat'." },
    { prompt: "Welke vorm is de verleden tijd van 'go'?", options: ["Goed", "Went", "Gone", "Going"], correctIndex: 1, explanation: "De verleden tijd van 'go' is 'went'." },
    { prompt: "Wat betekent 'weather'?", options: ["Tijd", "Klimaat", "Weer", "Seizoen"], correctIndex: 2, explanation: "'Weather' betekent 'weer'." },
    { prompt: "Welke zin betekent 'Ik heb een nieuwe fiets'?", options: ["I am a new bike.", "I have a new bike.", "I has a new bike.", "I be a new bike."], correctIndex: 1, explanation: "'I have a new bike' is de juiste vertaling." },
  ]
}

function buildDutchFallbackQuestions() {
  return [
    { prompt: "Welk woord is juist gespeld?", options: ["gebeurt", "gebeurdt", "gebuurt", "gebeurd"], correctIndex: 0, explanation: "'Gebeurt' is de juiste spelling in deze vorm." },
    { prompt: "Wat is een zelfstandig naamwoord?", options: ["Een woord dat een persoon, dier of ding noemt", "Een woord dat een handeling aangeeft", "Een woord dat een eigenschap noemt", "Een woord dat een voegwoord is"], correctIndex: 0, explanation: "Een zelfstandig naamwoord noemt een persoon, dier, plant of ding." },
    { prompt: "Welke zin bevat een bijvoeglijk naamwoord?", options: ["De hond rent.", "Het grote huis staat daar.", "Wij lopen naar school.", "Zij zingen hard."], correctIndex: 1, explanation: "'Grote' zegt iets over het huis en is een bijvoeglijk naamwoord." },
    { prompt: "Wat is het onderwerp in de zin 'De leerling leest een boek'?", options: ["boek", "leest", "de leerling", "een"], correctIndex: 2, explanation: "De leerling doet de handeling en is dus het onderwerp." },
    { prompt: "Welke leestekens gebruik je meestal bij een vraag?", options: ["Punt", "Komma", "Vraagteken", "Dubbele punt"], correctIndex: 2, explanation: "Bij een vraag gebruik je meestal een vraagteken." },
    { prompt: "Wat is een synoniem?", options: ["Een woord met dezelfde betekenis", "Een woord met de tegenovergestelde betekenis", "Een werkwoordsvorm", "Een naamwoordelijk gezegde"], correctIndex: 0, explanation: "Een synoniem heeft ongeveer dezelfde betekenis." },
  ]
}

function buildIslamFallbackQuestions() {
  return [
    { prompt: "Hoe heet het heilige boek van de islam?", options: ["Bijbel", "Thora", "Koran", "Psalmen"], correctIndex: 2, explanation: "De Koran is het heilige boek van de islam." },
    { prompt: "Hoe vaak bidden moslims gewoonlijk per dag?", options: ["3 keer", "4 keer", "5 keer", "6 keer"], correctIndex: 2, explanation: "De vijf dagelijkse gebeden horen bij de islamitische praktijk." },
    { prompt: "Wat is de naam van de vastenmaand in de islam?", options: ["Hadj", "Ramadan", "Eid", "Zakat"], correctIndex: 1, explanation: "Ramadan is de maand waarin veel moslims vasten." },
    { prompt: "Wat betekent zakat het best?", options: ["Bedevaart", "Liefdadigheid/aalmoes", "Vasten verbreken", "Vrijdaggebed"], correctIndex: 1, explanation: "Zakat is een vorm van verplichte liefdadigheid." },
    { prompt: "Naar welke stad gaan moslims voor de hadj?", options: ["Medina", "Jeruzalem", "Mekka", "Caïro"], correctIndex: 2, explanation: "De hadj is de bedevaart naar Mekka." },
    { prompt: "Wat is een moskee?", options: ["Een schoolvak", "Een feestdag", "Een gebedshuis", "Een kledingstuk"], correctIndex: 2, explanation: "Een moskee is een gebedshuis." },
  ]
}

function buildGeneralKnowledgeFallbackQuestions() {
  return [
    { prompt: "Wat is de grootste planeet van ons zonnestelsel?", options: ["Mars", "Aarde", "Jupiter", "Venus"], correctIndex: 2, explanation: "Jupiter is de grootste planeet van ons zonnestelsel." },
    { prompt: "Welke kleur krijg je door rood en geel te mengen?", options: ["Groen", "Oranje", "Paars", "Blauw"], correctIndex: 1, explanation: "Rood en geel samen geven oranje." },
    { prompt: "Hoeveel minuten zitten er in een uur?", options: ["30", "45", "60", "100"], correctIndex: 2, explanation: "Een uur heeft 60 minuten." },
    { prompt: "Welk dier staat bekend als het snelste landdier?", options: ["Leeuw", "Cheetah", "Paard", "Hert"], correctIndex: 1, explanation: "De cheetah is het snelste landdier." },
    { prompt: "In welk seizoen vallen de bladeren meestal van de bomen?", options: ["Lente", "Zomer", "Herfst", "Winter"], correctIndex: 2, explanation: "In de herfst verliezen veel bomen hun bladeren." },
    { prompt: "Welke oceaan ligt tussen Europa en Noord-Amerika?", options: ["Stille Oceaan", "Atlantische Oceaan", "Indische Oceaan", "Noordelijke IJszee"], correctIndex: 1, explanation: "Tussen Europa en Noord-Amerika ligt de Atlantische Oceaan." },
  ]
}

function buildGeneralFallbackQuestions(topic) {
  const cleanTopic = String(topic || "algemene kennis").trim()
  const lowerTopic = cleanTopic.toLowerCase()

  if (lowerTopic.includes("aardrijks")) return buildGeographyFallbackQuestions()
  if (lowerTopic.includes("geschiedenis")) return buildHistoryFallbackQuestions()
  if (lowerTopic.includes("biologie") || lowerTopic.includes("menselijk lichaam")) return buildBiologyFallbackQuestions()
  if (lowerTopic.includes("engels")) return buildEnglishFallbackQuestions()
  if (lowerTopic.includes("nederlands") || lowerTopic.includes("spelling") || lowerTopic.includes("taal")) return buildDutchFallbackQuestions()
  if (lowerTopic.includes("islam")) return buildIslamFallbackQuestions()
  if (lowerTopic.includes("algemene kennis")) return buildGeneralKnowledgeFallbackQuestions()

  return buildGeneralKnowledgeFallbackQuestions()
}

function buildFallbackQuestions({ topic, questionCount }) {
  const safeQuestionCount = Math.max(6, Math.min(24, Number(questionCount) || 12))
  const cleanTopic = String(topic || "algemene kennis").trim()
  const lowerTopic = cleanTopic.toLowerCase()
  const baseQuestions =
    lowerTopic.includes("breuk") || lowerTopic.includes("procent")
      ? buildFractionPercentFallbackQuestions()
      : buildGeneralFallbackQuestions(cleanTopic)

  return baseQuestions.slice(0, safeQuestionCount).map((question, index) => ({
    id: `fallback-${index + 1}`,
    category: cleanTopic.length > 40 ? "Gemixte quiz" : cleanTopic || "Quiz",
    imagePrompt:
      lowerTopic.includes("breuk") || lowerTopic.includes("procent")
        ? "students solving fractions and percentages on a bright classroom board, colorful educational illustration"
        : `engaging classroom poster about ${cleanTopic}, educational quiz illustration, vibrant lighting`,
    imageAlt: `Illustratie bij ${cleanTopic || "de quiz"}`,
    ...question,
  }))
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

function buildQuestionPrompt({ topic, audience, questionCount }) {
  return `
Maak precies ${questionCount} quizvragen in het Nederlands voor ${audience}.

Thema of onderwerp:
${topic.trim()}

Belangrijke regels:
- Dit onderwerp mag elk domein zijn: schoolvakken, algemene kennis, geschiedenis, aardrijkskunde, talen, wetenschap, cultuur, sport of religieuze kennis.
- Werk respectvol, feitelijk en zonder spot.
- Formuleer levendige maar duidelijke meerkeuzevragen voor VMBO-niveau.
- Elke vraag moet 4 antwoordopties hebben.
- Laat de vragen echt passen bij het onderwerp. Gebruik geen algemene standaardvragen die niet direct aansluiten.
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
}

function getQuestionPoolCacheKey(topic, audience) {
  return `${normalizeTopicKey(topic)}::${normalizeTopicKey(audience || "vmbo")}`
}

function formatProviderLabel(provider) {
  if (provider === "gemini") return "Gemini"
  if (provider === "groq") return "Groq"
  return provider
}

function getTopicCacheEntry(topic, audience) {
  return questionsPerTopic[getQuestionPoolCacheKey(topic, audience)] ?? null
}

function cloneCachedQuestionsForRound(cacheEntry, requestedCount) {
  return cacheEntry.questions.splice(0, requestedCount)
}

async function generateQuestionsWithGemini(topic, audience, minimumCount = QUESTION_POOL_LOW_WATERMARK) {
  if (!genAI) {
    throw new Error("GEMINI_API_KEY ontbreekt in de serveromgeving.")
  }

  const model = genAI.getGenerativeModel({ model: modelName })
  const prompt = buildQuestionPrompt({
    topic,
    audience,
    questionCount: QUESTION_BATCH_SIZE,
  })

  const result = await model.generateContent(prompt)
  const text = result.response.text()
  const parsed = parseQuestionsFromAiText(text)
  const normalized = normalizeQuestions(parsed, { minimumCount })

  console.log(`Gemini batch ontvangen (${normalized.length} geldige vragen, model ${modelName}).`)
  return rebalanceQuestions(normalized)
}

async function generateQuestionsWithGroq(topic, audience, minimumCount = QUESTION_POOL_LOW_WATERMARK) {
  if (!groq) {
    throw new Error("GROQ_API_KEY ontbreekt in de serveromgeving.")
  }

  const prompt = buildQuestionPrompt({
    topic,
    audience,
    questionCount: QUESTION_BATCH_SIZE,
  })

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

  const text = completion.choices?.[0]?.message?.content || ""
  const parsed = parseQuestionsFromAiText(text)
  const normalized = normalizeQuestions(parsed, { minimumCount })

  console.log(`Groq batch ontvangen (${normalized.length} geldige vragen, model ${groqModel}).`)
  return rebalanceQuestions(normalized)
}

async function generateQuestions({ topic, audience, minimumCount = QUESTION_POOL_LOW_WATERMARK }) {
  if (!topic?.trim()) {
    throw new Error("Voer eerst een onderwerp of thema in.")
  }

  if (!genAI && !groq) {
    throw new Error("Geen AI-provider geconfigureerd op de server.")
  }

  const targetAudience = audience?.trim() || "vmbo"
  const providers = [
    ...(genAI
      ? [
          {
            name: "gemini",
            run: () => generateQuestionsWithGemini(topic, targetAudience, minimumCount),
          },
        ]
      : []),
    ...(groq
      ? [
          {
            name: "groq",
            run: () => generateQuestionsWithGroq(topic, targetAudience, minimumCount),
          },
        ]
      : []),
  ]

  const providerErrors = []

  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index]

    try {
      if (index > 0) {
        console.warn(`AI-provider ${providers[index - 1].name} faalde. Fallback naar ${provider.name}.`)
      }

      const questions = await provider.run()
      return {
        questions,
        provider: provider.name,
        providerLabel: formatProviderLabel(provider.name),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Onbekende AI-fout"
      providerErrors.push(`${provider.name}: ${message}`)
      console.error(`AI batchgeneratie mislukt via ${provider.name}:`, message)
    }
  }

  throw new Error(providerErrors.join(" | "))
}

async function refillQuestionPool({ topic, audience, minimumCount }) {
  const poolKey = getQuestionPoolCacheKey(topic, audience)
  const existingPromise = topicGenerationPromises[poolKey]

  if (existingPromise) {
    console.log(`Vraagcache: lopende AI-generatie hergebruikt voor "${poolKey}".`)
    return existingPromise
  }

  const generationPromise = withTimeout(
    generateQuestions({ topic, audience, minimumCount }),
    QUESTION_GENERATION_TIMEOUT_MS
  )
    .then((generationResult) => {
      const cacheEntry = {
        topicKey: normalizeTopicKey(topic),
        topicLabel: String(topic ?? "").trim(),
        audience: audience?.trim() || "vmbo",
        generatedAt: new Date().toISOString(),
        provider: generationResult.provider,
        providerLabel: generationResult.providerLabel,
        questions: [...generationResult.questions],
      }

      questionsPerTopic[poolKey] = cacheEntry

      console.log(
        `Vraagcache vernieuwd: ${cacheEntry.questions.length} vragen voor "${cacheEntry.topicLabel || cacheEntry.topicKey}" (${cacheEntry.audience}).`
      )

      return cacheEntry
    })
    .catch((error) => {
      console.error(`Vraagcache refill mislukt voor "${poolKey}":`, error instanceof Error ? error.message : error)
      throw error
    })
    .finally(() => {
      delete topicGenerationPromises[poolKey]
    })

  topicGenerationPromises[poolKey] = generationPromise
  return generationPromise
}

async function ensureQuestionPool({ topic, audience, questionCount }) {
  const normalizedTopicKey = normalizeTopicKey(topic)
  const normalizedAudience = String(audience?.trim() || "vmbo")
  const requiredCount = Math.max(6, Math.min(24, Number(questionCount) || 12))
  let cacheEntry = getTopicCacheEntry(topic, normalizedAudience)
  const needsRefill =
    !cacheEntry ||
    cacheEntry.questions.length < requiredCount ||
    cacheEntry.questions.length < QUESTION_POOL_LOW_WATERMARK

  if (needsRefill) {
    console.log("Vraagcache refill nodig", {
      hasEntry: Boolean(cacheEntry),
      available: cacheEntry?.questions.length ?? 0,
      requiredCount,
      topic: normalizedTopicKey,
      audience: normalizedAudience,
    })

    cacheEntry = await refillQuestionPool({
      topic,
      audience: normalizedAudience,
      minimumCount: requiredCount,
    })
  } else {
    console.log(
      `Vraagcache hergebruikt: ${cacheEntry.questions.length} vragen beschikbaar voor "${normalizedTopicKey}".`
    )
  }

  if (!cacheEntry || cacheEntry.questions.length < requiredCount) {
    throw new Error(
      `Vraagcache bevat te weinig vragen (${cacheEntry?.questions.length ?? 0}/${requiredCount}) voor deze ronde.`
    )
  }

  return cloneCachedQuestionsForRound(cacheEntry, requiredCount)
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
      provider: gameMeta.source || null,
      providerLabel: gameMeta.providerLabel || null,
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

  socket.on("host:generate", async ({ topic, audience, questionCount, teamNames, questionDurationSec }) => {
    if (!requireHost(socket)) return

    const cleanTopic = String(topic ?? "").trim()
    const cleanAudience = String(audience?.trim() || "vmbo")
    const safeQuestionCount = Math.max(6, Math.min(24, Number(questionCount) || 12))
    const safeDuration = Math.max(8, Math.min(60, Number(questionDurationSec) || 20))

    console.log("host:generate ontvangen", {
      topic: cleanTopic,
      audience: cleanAudience,
      questionCount: safeQuestionCount,
      questionDurationSec: safeDuration,
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
        questions = await ensureQuestionPool({
          topic: cleanTopic,
          audience: cleanAudience,
          questionCount: safeQuestionCount,
        })

        const cacheEntry = getTopicCacheEntry(cleanTopic, cleanAudience)

        console.log(
          `Ronde geladen: ${questions.length} vragen actief, ${cacheEntry?.questions.length ?? 0} vragen blijven in de cache voor dit onderwerp.`
        )
        console.info(
          `Ronde gegenereerd via ${cacheEntry?.providerLabel || cacheEntry?.provider || "AI-provider"}.`
        )
      } catch (aiError) {
        const fallbackMessage = aiError instanceof Error ? aiError.message : "AI-fout"
        console.error("AI-generatie mislukt, fallback geactiveerd:", fallbackMessage)
        questions = buildFallbackQuestions({
          topic: cleanTopic,
          audience: cleanAudience,
          questionCount: safeQuestionCount,
        })
        socket.emit("host:error", {
          message: `AI-generatie lukte niet direct. Er is een reservequiz gestart. Details: ${fallbackMessage}`,
        })
      }

      currentQuestionIndex = 0
      answeredPlayers = new Set()
      const cacheEntry = getTopicCacheEntry(cleanTopic, cleanAudience)
      gameMeta = {
        topic: cleanTopic,
        audience: cleanAudience,
        questionCount: questions.length,
        questionDurationSec: safeDuration,
        questionStartedAt: new Date().toISOString(),
        status: "live",
        source: cacheEntry?.provider || "ai",
        providerLabel: cacheEntry?.providerLabel || "AI",
        generatedAt: new Date().toISOString(),
      }

      console.log(`vragen (${modelName}):`, questions.length)
      broadcastState()
      socket.emit("host:generate:success", {
        count: questions.length,
        provider: cacheEntry?.provider || null,
        providerLabel: cacheEntry?.providerLabel || null,
      })
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
      gameMeta = {
        ...gameMeta,
        status: questions.length ? "finished" : "idle",
        questionStartedAt: null,
      }
      broadcastState()
      return
    }

    currentQuestionIndex += 1
    answeredPlayers = new Set()
    stampQuestionStart()
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
      questionDurationSec: 20,
      questionStartedAt: null,
      status: "idle",
      source: "idle",
      providerLabel: null,
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
