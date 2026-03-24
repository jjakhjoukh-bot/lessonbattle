import { useEffect, useMemo, useRef, useState } from "react"
import { io } from "socket.io-client"
import {
  activateHomeMathSnapshot,
  nextHomeMathTask,
  readHomeMathSnapshot,
  retryHomeMathIntake,
  submitHomeMathAnswer,
  writeHomeMathSnapshotFromServer,
} from "./mathHome"
import "./App.css"

const socket = io(window.location.origin.startsWith("http://localhost:5173") ? "http://localhost:3001" : window.location.origin)
const HOST_SESSION_KEY = "lessonbattle-host-session"
const HOST_ROOM_BACKUP_KEY_PREFIX = "lessonbattle-host-room-backup"
const HOST_LAST_ROOM_KEY_PREFIX = "lessonbattle-host-last-room"
const PLAYER_SESSION_KEY = "lessonbattle-player-session"
const IMAGE_RENDER_VERSION = "20260318a"
const MAX_MANUAL_UPLOAD_FILE_BYTES = 20 * 1024 * 1024
const MAX_MANUAL_UPLOAD_DATA_BYTES = 4 * 1024 * 1024
const TARGET_MANUAL_UPLOAD_DATA_BYTES = 1400 * 1024
const MAX_MANUAL_UPLOAD_DIMENSION = 1280
const MIN_MANUAL_UPLOAD_DIMENSION = 480
const MANUAL_UPLOAD_QUALITY_STEPS = [0.82, 0.72, 0.62, 0.52, 0.44]
const MAX_CLASSROOM_IMPORT_FILE_BYTES = 6 * 1024 * 1024
const MATH_LEVEL_OPTIONS = ["0f", "1f", "2f", "3f", "4f"]
const PLAYER_JOIN_MODE_CLASSROOM = "classroom"
const PLAYER_JOIN_MODE_HOME_MATH = "home-math"
const SUPPORT_MAILTO_LINK = "mailto:?subject=Vraag%20over%20Lesson%20Battle&body=Hallo,%0D%0A%0D%0AIk%20heb%20een%20vraag%20over%20Lesson%20Battle:%0D%0A%0D%0A"
const QR_IMAGE_SERVICE_BASE = "https://api.qrserver.com/v1/create-qr-code/"
const DEFAULT_HOST_SESSION = {
  authenticated: false,
  username: "",
  displayName: "",
  role: "",
  canManageAccounts: false,
  roomCode: "",
  sessionToken: "",
}

const HOST_WORKSPACE_OPTIONS = [
  {
    id: "home",
    label: "Start",
    description: "Rustige startpagina met snelle acties en overzicht.",
  },
  {
    id: "lesson",
    label: "Lesmodus",
    description: "Bouw een lesstap met uitleg, opdracht en live vraag.",
  },
  {
    id: "presentation",
    label: "Presentatieweergave",
    description: "Maak een diareeks voor het digibord met passende beelden.",
  },
  {
    id: "practice",
    label: "Oefentoets",
    description: "Zet een oefentoets klaar die leerlingen rustig kunnen maken.",
  },
  {
    id: "battle",
    label: "Battle",
    description: "Start een snelle quiz met timer, snelheid en live scores.",
  },
  {
    id: "math",
    label: "Rekenen",
    description: "Beheer de instaptoets en adaptieve rekenroute.",
  },
  {
    id: "management",
    label: "Beheer",
    description: "Bekijk leerlingen, geschiedenis, bibliotheek en docentaccounts.",
  },
]

const PRACTICE_QUESTION_FORMAT_OPTIONS = [
  { id: "multiple-choice", label: "Meerkeuze" },
  { id: "typed", label: "Flashcards / typen" },
  { id: "mixed", label: "Gemengd" },
]

const MANAGEMENT_PANEL_OPTIONS = [
  {
    id: "learners",
    label: "Leerlingen",
    description: "Zoek leerlingen, zie voortgang en beheer codes.",
  },
  {
    id: "classes",
    label: "Klassen",
    description: "Beheer klassen, leerlingcodes en vaste rosters.",
  },
  {
    id: "library",
    label: "Bibliotheek",
    description: "Open of verwijder opgeslagen lessen.",
  },
  {
    id: "history",
    label: "Geschiedenis",
    description: "Bekijk en laad eerdere sessies opnieuw.",
  },
  {
    id: "accounts",
    label: "Docentenaccounts",
    description: "Maak extra docentaccounts aan en beheer ze.",
  },
]

function readStoredHostSession() {
  try {
    const stored = window.sessionStorage.getItem(HOST_SESSION_KEY)
    if (!stored) {
      return {
        hostSession: DEFAULT_HOST_SESSION,
        loginForm: { username: "", password: "" },
      }
    }
    const parsed = JSON.parse(stored)
    const storedUsername = String(parsed?.lastUsername || parsed?.username || "").trim()
    const storedToken = String(parsed?.sessionToken || "").trim()
    return {
      hostSession: {
        authenticated: Boolean(parsed?.authenticated && parsed?.username && storedToken),
        username: parsed?.username || "",
        displayName: parsed?.displayName || parsed?.username || "",
        role: parsed?.role || "",
        canManageAccounts: Boolean(parsed?.canManageAccounts),
        roomCode: parsed?.roomCode || "",
        sessionToken: storedToken,
      },
      loginForm: {
        username: storedUsername,
        password: "",
      },
    }
  } catch {
    return {
      hostSession: DEFAULT_HOST_SESSION,
      loginForm: { username: "", password: "" },
    }
  }
}

function lessonPackageFromFlags({ includePracticeTest, includePresentation }) {
  if (includePracticeTest && includePresentation) return "complete"
  if (includePracticeTest) return "practice"
  if (includePresentation) return "presentation"
  return "lesson"
}

function createPlayerSessionId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID()
  return `player-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function readJoinSessionCodeFromUrl() {
  const params = new URLSearchParams(window.location.search)
  return String(params.get("sessionCode") || params.get("roomCode") || "")
    .trim()
    .toUpperCase()
}

function buildClassroomJoinUrl(roomCode = "") {
  const normalizedRoomCode = String(roomCode || "").trim().toUpperCase()
  if (!normalizedRoomCode) return ""
  const url = new URL("/join", window.location.origin)
  url.searchParams.set("sessionCode", normalizedRoomCode)
  return url.toString()
}

function buildQrCodeImageUrl(value = "", size = 240) {
  if (!value) return ""
  const url = new URL(QR_IMAGE_SERVICE_BASE)
  url.searchParams.set("data", value)
  url.searchParams.set("size", `${size}x${size}`)
  url.searchParams.set("margin", "0")
  url.searchParams.set("ecc", "M")
  url.searchParams.set("format", "svg")
  return url.toString()
}

function formatHistoryDate(value) {
  if (!value) return "Onbekende datum"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Onbekende datum"
  return new Intl.DateTimeFormat("nl-NL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

function formatDateTimeLocalInput(value) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const offsetMs = date.getTimezoneOffset() * 60 * 1000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16)
}

function normalizeSearchText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function matchesSearchTokens(value = "", query = "") {
  const haystack = normalizeSearchText(value)
  const needles = normalizeSearchText(query)
    .split(" ")
    .filter(Boolean)
  if (!needles.length) return true
  return needles.every((token) => haystack.includes(token))
}

function csvEscape(value) {
  const text = String(value ?? "")
  if (/[",\n;]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function slugifyFilePart(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

function downloadCsvFile(filename, headers, rows) {
  const lines = [headers.map(csvEscape).join(";"), ...rows.map((row) => row.map(csvEscape).join(";"))]
  const blob = new Blob([`\uFEFF${lines.join("\n")}`], { type: "text/csv;charset=utf-8;" })
  const blobUrl = window.URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = blobUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.URL.revokeObjectURL(blobUrl)
}

function sortTeamsByScore(teams = []) {
  return [...teams].sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
}

function getTeamRaceSummary(teams = []) {
  const sortedTeams = sortTeamsByScore(teams)
  const leader = sortedTeams[0] ?? null
  const runnerUp = sortedTeams[1] ?? null
  const gap = leader && runnerUp ? Math.max(0, leader.score - runnerUp.score) : 0

  return {
    sortedTeams,
    leader,
    runnerUp,
    gap,
  }
}

function formatAnswerSpeed(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return ""
  const seconds = elapsedMs >= 10000 ? (elapsedMs / 1000).toFixed(0) : (elapsedMs / 1000).toFixed(1)
  return `${seconds}s`
}

function buildAnswerStatusText(payload) {
  if (!payload) return "Wacht op de volgende vraag."
  if (payload.waitingForReveal) {
    return "Je antwoord is opgeslagen. Wacht tot het juiste antwoord wordt getoond."
  }
  if (payload.correct) {
    const multiplierText = payload.multiplier > 1 ? " Deze vraag telde dubbel." : ""
    return `Goed! +${payload.awardedPoints || 0} punten.${multiplierText}`
  }
  return "Niet correct. Kijk naar de uitleg en ga daarna verder."
}

function getPracticeQuestionFormatLabel(format = "") {
  const normalized = String(format || "").trim().toLowerCase()
  return PRACTICE_QUESTION_FORMAT_OPTIONS.find((option) => option.id === normalized)?.label || "Meerkeuze"
}

function tokenizeComparableText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .split(/\s+/)
    .filter((part) => part.length >= 1)
}

function normalizeComparableText(value = "") {
  return tokenizeComparableText(value).join(" ").trim()
}

function extractAcceptedAnswerCandidates(value = "") {
  const source = String(value || "").trim()
  if (!source) return []

  const quoted = [...source.matchAll(/["'“”‘’]([^"'“”‘’]+)["'“”‘’]/g)].map((match) => match[1])
  const split = source
    .replace(/\b(bijvoorbeeld|zoals|denk aan|verwacht ongeveer)\b[:]?/gi, "")
    .split(/[,;/]|\sof\s/gi)
    .map((part) => part.trim())
    .filter(Boolean)

  return [...new Set([...quoted, ...split].map((part) => normalizeComparableText(part)).filter(Boolean))]
}

function matchesAcceptedAnswer(response = "", candidate = "") {
  const normalizedResponse = normalizeComparableText(response)
  const normalizedCandidate = normalizeComparableText(candidate)

  if (!normalizedResponse || !normalizedCandidate) return false
  if (normalizedResponse === normalizedCandidate) return true

  const responseTokens = tokenizeComparableText(normalizedResponse)
  const candidateTokens = tokenizeComparableText(normalizedCandidate)

  if (responseTokens.length === 1 && candidateTokens.includes(responseTokens[0])) return true
  if (candidateTokens.length === 1 && responseTokens.includes(candidateTokens[0])) return true

  return (
    normalizedResponse.length >= 5 &&
    normalizedCandidate.length >= 5 &&
    (normalizedResponse.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedResponse))
  )
}

function createSelfPracticeSession(payload = {}) {
  const questions = Array.isArray(payload.questions)
    ? payload.questions.map((question, index) => ({
        ...question,
        id: question.id || `self-practice-${index + 1}`,
        options: [...(question.options || [])],
        acceptedAnswers: [...(question.acceptedAnswers || [])],
      }))
    : []

  return {
    id: `self-practice-${Date.now().toString(36)}`,
    title: String(payload.title || "Oefentoets").trim() || "Oefentoets",
    instructions:
      String(payload.instructions || "Werk zelfstandig, kijk na elke vraag naar de uitleg en ga daarna verder.").trim() ||
      "Werk zelfstandig, kijk na elke vraag naar de uitleg en ga daarna verder.",
    topic: String(payload.topic || "").trim(),
    providerLabel: String(payload.providerLabel || "Lesson Battle").trim() || "Lesson Battle",
    questionFormat: String(payload.questionFormat || "multiple-choice").trim() || "multiple-choice",
    questions,
    currentIndex: 0,
    currentResult: null,
    answers: [],
    startedAt: new Date().toISOString(),
    finishedAt: "",
  }
}

function evaluateSelfPracticeQuestion(question, submission = {}) {
  const questionType = String(question?.questionType || "multiple-choice").trim().toLowerCase()
  if (questionType === "typed") {
    const answerText = String(submission.answerText || "").trim()
    const acceptedAnswers = [
      ...new Set(
        [...(question.acceptedAnswers || []), question.displayAnswer || ""]
          .flatMap((entry) => [entry, ...extractAcceptedAnswerCandidates(entry)])
          .map((entry) => String(entry || "").trim())
          .filter(Boolean)
      ),
    ]
    const correct = acceptedAnswers.some((candidate) => matchesAcceptedAnswer(answerText, candidate))
    return {
      questionType: "typed",
      answerIndex: null,
      answerText,
      correct,
      correctIndex: null,
      correctAnswer: String(question.displayAnswer || acceptedAnswers[0] || "").trim(),
      explanation: question.explanation || "",
      awardedPoints: 0,
      basePoints: 0,
      speedBonus: 0,
      multiplier: 1,
    }
  }

  const answerIndex = Number(submission.answerIndex)
  const correctIndex = Number(question?.correctIndex)
  return {
    questionType: "multiple-choice",
    answerIndex,
    answerText: "",
    correct: Number.isInteger(answerIndex) && answerIndex === correctIndex,
    correctIndex,
    correctAnswer: String(question?.options?.[correctIndex] || "").trim(),
    explanation: question?.explanation || "",
    awardedPoints: 0,
    basePoints: 0,
    speedBonus: 0,
    multiplier: 1,
  }
}

function submitSelfPracticeSessionAnswer(session, submission = {}) {
  if (!session?.questions?.length) return session
  const currentQuestion = session.questions[session.currentIndex] || null
  if (!currentQuestion) return session
  const result = evaluateSelfPracticeQuestion(currentQuestion, submission)
  const nextAnswers = [
    ...session.answers,
    {
      questionId: currentQuestion.id,
      prompt: currentQuestion.prompt,
      answeredAt: new Date().toISOString(),
      ...result,
    },
  ]

  return {
    ...session,
    currentResult: result,
    answers: nextAnswers,
  }
}

function advanceSelfPracticeSession(session) {
  if (!session?.questions?.length) return session
  const isLastQuestion = session.currentIndex + 1 >= session.questions.length
  if (isLastQuestion) {
    return {
      ...session,
      finishedAt: session.finishedAt || new Date().toISOString(),
      currentResult: null,
    }
  }

  return {
    ...session,
    currentIndex: session.currentIndex + 1,
    currentResult: null,
  }
}

function formatMathLevelLabel(level) {
  return String(level || "").trim().toUpperCase()
}

function formatAccuracy(rate = 0) {
  return `${Math.max(0, Number(rate) || 0)}%`
}

function formatMathDifficultyLabel(difficulty) {
  const safeDifficulty = Math.max(1, Math.min(5, Number(difficulty) || 1))
  return ["instap", "basis", "stevig", "uitdagend", "topniveau"][safeDifficulty - 1]
}

function formatMathDomainLabel(domain = "") {
  const normalized = String(domain || "").trim().toLowerCase()
  if (normalized === "meten en meetkunde") return "Meten en meetkunde"
  if (normalized === "verhoudingen") return "Verhoudingen"
  if (normalized === "verbanden") return "Verbanden"
  if (normalized === "getallen") return "Getallen"
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "Rekenen"
}

function getMathRecentStreak(answerHistory = []) {
  let streak = 0
  for (let index = answerHistory.length - 1; index >= 0; index -= 1) {
    const entry = answerHistory[index]
    if (!entry?.correct) break
    streak += 1
  }
  return streak
}

function getMathTrendLabel(answerHistory = []) {
  const recent = answerHistory.slice(-6)
  if (recent.length < 4) return "Nog te weinig data"
  const midpoint = Math.floor(recent.length / 2)
  const firstHalf = recent.slice(0, midpoint)
  const secondHalf = recent.slice(midpoint)
  const firstScore = firstHalf.filter((entry) => entry?.correct).length / Math.max(1, firstHalf.length)
  const secondScore = secondHalf.filter((entry) => entry?.correct).length / Math.max(1, secondHalf.length)
  if (secondScore - firstScore >= 0.2) return "Stijgende lijn"
  if (firstScore - secondScore >= 0.2) return "Daalt weg"
  return "Blijft ongeveer gelijk"
}

function getMathSupportLabel(player = {}) {
  if ((player.accuracyRate || 0) >= 80 && (player.practiceQuestionCount || 0) >= 6) return "Zelfstandig"
  if ((player.accuracyRate || 0) < 50 && (player.answeredCount || 0) >= 4) return "Extra uitleg nodig"
  if ((player.workLabel || "").toLowerCase().includes("traag")) return "Tempo bewaken"
  return "Volgen"
}

function buildHostBackupStorageKey(username = "") {
  return `${HOST_ROOM_BACKUP_KEY_PREFIX}-${String(username || "default").trim().toLowerCase() || "default"}`
}

function buildHostLastRoomStorageKey(username = "") {
  return `${HOST_LAST_ROOM_KEY_PREFIX}-${String(username || "default").trim().toLowerCase() || "default"}`
}

function readHostRoomBackup(username = "") {
  if (!username) return null
  try {
    const stored = window.localStorage.getItem(buildHostBackupStorageKey(username))
    if (!stored) return null
    const parsed = JSON.parse(stored)
    if (!parsed?.snapshot) return null
    return {
      username: parsed.username || username,
      roomCode: parsed.roomCode || "",
      savedAt: parsed.savedAt || "",
      snapshot: parsed.snapshot,
    }
  } catch {
    return null
  }
}

function writeHostRoomBackup(username = "", snapshot) {
  if (!username || !snapshot) return null
  const payload = {
    username,
    roomCode: snapshot?.code || "",
    savedAt: new Date().toISOString(),
    snapshot,
  }
  window.localStorage.setItem(buildHostBackupStorageKey(username), JSON.stringify(payload))
  return payload
}

function clearHostRoomBackup(username = "") {
  if (!username) return
  window.localStorage.removeItem(buildHostBackupStorageKey(username))
}

function readHostLastRoomCode(username = "") {
  if (!username) return ""
  return String(window.localStorage.getItem(buildHostLastRoomStorageKey(username)) || "").trim().toUpperCase()
}

function writeHostLastRoomCode(username = "", roomCode = "") {
  if (!username) return
  const normalizedRoomCode = String(roomCode || "").trim().toUpperCase()
  if (!normalizedRoomCode) return
  window.localStorage.setItem(buildHostLastRoomStorageKey(username), normalizedRoomCode)
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ""))
    reader.onerror = () => reject(new Error("Bestand kon niet worden gelezen."))
    reader.readAsDataURL(file)
  })
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error("Bestand kon niet worden gelezen."))
    reader.readAsArrayBuffer(file)
  })
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ""
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return window.btoa(binary)
}

function estimateDataUrlBytes(dataUrl) {
  const base64Payload = String(dataUrl || "").split(",")[1] || ""
  return Math.floor((base64Payload.length * 3) / 4)
}

function loadImageElement(source) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("Afbeelding kon niet worden geopend."))
    image.src = source
  })
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ""))
    reader.onerror = () => reject(new Error("De geoptimaliseerde afbeelding kon niet worden gelezen."))
    reader.readAsDataURL(blob)
  })
}

function canvasToDataUrl(canvas, mimeType = "image/jpeg", quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob(async (blob) => {
        if (!blob) {
          reject(new Error("De afbeelding kon niet worden omgezet."))
          return
        }
        try {
          resolve(await blobToDataUrl(blob))
        } catch (error) {
          reject(error instanceof Error ? error : new Error("De afbeelding kon niet worden gelezen."))
        }
      }, mimeType, quality)
      return
    }

    try {
      resolve(canvas.toDataURL(mimeType, quality))
    } catch {
      reject(new Error("De afbeelding kon niet worden omgezet."))
    }
  })
}

async function loadRenderableImage(file, objectUrl) {
  if (window.createImageBitmap) {
    try {
      return await window.createImageBitmap(file)
    } catch {
      // Fallback to Image below.
    }
  }
  return loadImageElement(objectUrl)
}

async function optimizeImageFile(file) {
  if (Number(file?.size) > MAX_MANUAL_UPLOAD_FILE_BYTES) {
    throw new Error("De afbeelding is te groot. Gebruik maximaal 20 MB.")
  }

  const normalizedType = String(file?.type || "").toLowerCase()
  if (normalizedType === "image/svg+xml") {
    const dataUrl = await readFileAsDataUrl(file)
    if (estimateDataUrlBytes(dataUrl) > MAX_MANUAL_UPLOAD_DATA_BYTES) {
      throw new Error("De SVG is te groot. Gebruik maximaal 4 MB.")
    }
    return dataUrl
  }

  const objectUrl = URL.createObjectURL(file)
  let image = null
  try {
    image = await loadRenderableImage(file, objectUrl)
    const widthScale = MAX_MANUAL_UPLOAD_DIMENSION / Math.max(1, image.width)
    const heightScale = MAX_MANUAL_UPLOAD_DIMENSION / Math.max(1, image.height)
    let renderScale = Math.min(1, widthScale, heightScale)
    let bestDataUrl = ""
    let bestByteSize = Number.POSITIVE_INFINITY

    while (renderScale > 0) {
      const width = Math.max(1, Math.round(image.width * renderScale))
      const height = Math.max(1, Math.round(image.height * renderScale))
      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext("2d")
      if (!context) {
        break
      }

      context.fillStyle = "#ffffff"
      context.fillRect(0, 0, width, height)
      context.drawImage(image, 0, 0, width, height)

      for (const quality of MANUAL_UPLOAD_QUALITY_STEPS) {
        const candidateDataUrl = await canvasToDataUrl(canvas, "image/jpeg", quality)
        const candidateByteSize = estimateDataUrlBytes(candidateDataUrl)
        if (candidateByteSize < bestByteSize) {
          bestDataUrl = candidateDataUrl
          bestByteSize = candidateByteSize
        }
        if (candidateByteSize <= TARGET_MANUAL_UPLOAD_DATA_BYTES) {
          return candidateDataUrl
        }
      }

      if (width <= MIN_MANUAL_UPLOAD_DIMENSION && height <= MIN_MANUAL_UPLOAD_DIMENSION) {
        break
      }
      renderScale *= 0.82
    }

    if (bestDataUrl && bestByteSize <= MAX_MANUAL_UPLOAD_DATA_BYTES) {
      return bestDataUrl
    }

    throw new Error("De afbeelding blijft te groot na verkleinen. Kies een kleinere afbeelding.")
  } catch (error) {
    if (/(heic|heif)/i.test(normalizedType)) {
      throw new Error("Deze HEIC-foto wordt op dit apparaat niet goed ondersteund. Zet hem om naar JPG/PNG of maak eerst een screenshot van de foto.")
    }
    if (error instanceof Error) {
      throw error
    }
    throw new Error("De afbeelding kon niet worden verwerkt.")
  } finally {
    if (image && typeof image.close === "function") {
      image.close()
    }
    URL.revokeObjectURL(objectUrl)
  }
}

function App() {
  const path = window.location.pathname

  if (path === "/join") {
    return <PlayerPage />
  }

  return <HostPage />
}

function useQuizState() {
  const [players, setPlayers] = useState([])
  const [teams, setTeams] = useState([])
  const [leaderboard, setLeaderboard] = useState([])
  const [game, setGame] = useState({
    topic: "",
    audience: "vmbo",
    questionCount: 12,
    questionDurationSec: 20,
    status: "idle",
    mode: "battle",
    questionMultiplier: 1,
    finalSprintActive: false,
    leadingTeamName: "",
    runnerUpTeamName: "",
    leadingGap: 0,
    currentQuestionIndex: -1,
    totalQuestions: 0,
    currentPhaseIndex: -1,
    totalPhases: 0,
    question: null,
    lesson: null,
    math: null,
  })

  useEffect(() => {
    const onInit = (payload) => {
      setPlayers(payload.players ?? [])
      setTeams(payload.teams ?? [])
      setLeaderboard(payload.leaderboard ?? [])
      setGame(payload.game ?? {})
    }
    const onLessonPromptUpdate = ({ lesson, currentPhaseIndex, promptVersion }) => {
      setGame((current) => {
        if (current.mode !== "lesson") return current
        return {
          ...current,
          currentPhaseIndex: currentPhaseIndex ?? current.currentPhaseIndex,
          lesson: lesson
            ? {
                ...(current.lesson || {}),
                ...lesson,
                currentPhase: {
                  ...(current.lesson?.currentPhase || {}),
                  ...(lesson.currentPhase || {}),
                },
                promptVersion: promptVersion ?? lesson.promptVersion ?? current.lesson?.promptVersion ?? 0,
              }
            : current.lesson,
        }
      })
    }

    socket.on("state:init", onInit)
    socket.on("players:update", setPlayers)
    socket.on("teams:update", setTeams)
    socket.on("leaderboard:update", setLeaderboard)
    socket.on("game:update", setGame)
    socket.on("lesson:prompt:update", onLessonPromptUpdate)

    return () => {
      socket.off("state:init", onInit)
      socket.off("players:update", setPlayers)
      socket.off("teams:update", setTeams)
      socket.off("leaderboard:update", setLeaderboard)
      socket.off("game:update", setGame)
      socket.off("lesson:prompt:update", onLessonPromptUpdate)
    }
  }, [])

  return { players, teams, leaderboard, game }
}

function HostPage() {
  const { players, teams, leaderboard, game } = useQuizState()
  const storedHostSession = readStoredHostSession()
  const [sessionMode, setSessionMode] = useState("battle")
  const [hostWorkspace, setHostWorkspace] = useState("home")
  const [managementPanel, setManagementPanel] = useState("learners")
  const [hostMenuOpen, setHostMenuOpen] = useState(false)
  const [hostProfileOpen, setHostProfileOpen] = useState(false)
  const [joinQrOpen, setJoinQrOpen] = useState(false)
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false)
  const [topic, setTopic] = useState("")
  const [audience, setAudience] = useState("vmbo")
  const [questionCount, setQuestionCount] = useState(12)
  const [questionDurationSec, setQuestionDurationSec] = useState(20)
  const [lessonModel, setLessonModel] = useState("edi")
  const [lessonPackage, setLessonPackage] = useState("lesson")
  const [mathBand, setMathBand] = useState("1f")
  const [mathAssignmentTitle, setMathAssignmentTitle] = useState("")
  const [mathAssignmentDueAt, setMathAssignmentDueAt] = useState("")
  const [mathTargetPracticeCount, setMathTargetPracticeCount] = useState(12)
  const [selectedMathClassId, setSelectedMathClassId] = useState("")
  const [lessonDurationMinutes, setLessonDurationMinutes] = useState(45)
  const [presentationSlideCount, setPresentationSlideCount] = useState(6)
  const [practiceQuestionCount, setPracticeQuestionCount] = useState(8)
  const [practiceQuestionFormat, setPracticeQuestionFormat] = useState("multiple-choice")
  const [includeVideoPlan, setIncludeVideoPlan] = useState(false)
  const [lessonPromptDraft, setLessonPromptDraft] = useState("")
  const [lessonExpectedAnswerDraft, setLessonExpectedAnswerDraft] = useState("")
  const [teamNamesInput, setTeamNamesInput] = useState("Team Zon\nTeam Oceaan")
  const [groupModeEnabledDraft, setGroupModeEnabledDraft] = useState(false)
  const [isEditingTeams, setIsEditingTeams] = useState(false)
  const [status, setStatus] = useState("Vul het onderwerp in, kies eventueel groepen en start de ronde.")
  const [hostInsights, setHostInsights] = useState(null)
  const [lessonLibrary, setLessonLibrary] = useState([])
  const [classrooms, setClassrooms] = useState([])
  const [classroomSearch, setClassroomSearch] = useState("")
  const [classroomAudienceFilter, setClassroomAudienceFilter] = useState("all")
  const [sessionHistory, setSessionHistory] = useState([])
  const [librarySearch, setLibrarySearch] = useState("")
  const [libraryAudienceFilter, setLibraryAudienceFilter] = useState("all")
  const [librarySectionFilter, setLibrarySectionFilter] = useState("all")
  const [libraryFolderFilter, setLibraryFolderFilter] = useState("all")
  const [libraryMetaDrafts, setLibraryMetaDrafts] = useState({})
  const [historySearch, setHistorySearch] = useState("")
  const [historyTypeFilter, setHistoryTypeFilter] = useState("all")
  const [historyCategoryFilter, setHistoryCategoryFilter] = useState("all")
  const [teacherAccounts, setTeacherAccounts] = useState([])
  const [teacherAccountForm, setTeacherAccountForm] = useState({
    username: "",
    displayName: "",
    password: "",
    role: "teacher",
  })
  const [teacherPasswordDrafts, setTeacherPasswordDrafts] = useState({})
  const [learnerCodeDrafts, setLearnerCodeDrafts] = useState({})
  const [newMathLearner, setNewMathLearner] = useState({ name: "", learnerCode: "" })
  const [newClassroomForm, setNewClassroomForm] = useState({ name: "", sectionName: "Algemene sectie", audience: "vmbo" })
  const [classroomDrafts, setClassroomDrafts] = useState({})
  const [classroomLearnerDrafts, setClassroomLearnerDrafts] = useState({})
  const [classroomLearnerEditDrafts, setClassroomLearnerEditDrafts] = useState({})
  const [classroomImportBusyId, setClassroomImportBusyId] = useState("")
  const [loginForm, setLoginForm] = useState(storedHostSession.loginForm)
  const [hostSession, setHostSession] = useState(storedHostSession.hostSession)
  const [localRoomBackup, setLocalRoomBackup] = useState(() =>
    readHostRoomBackup(storedHostSession.hostSession.username || storedHostSession.loginForm.username)
  )
  const [manualSlideImageUrlDraft, setManualSlideImageUrlDraft] = useState("")
  const [manualSlideImageAltDraft, setManualSlideImageAltDraft] = useState("")
  const [manualSlideUploadName, setManualSlideUploadName] = useState("")
  const [slideImageBusy, setSlideImageBusy] = useState(false)
  const hostSessionRef = useRef(hostSession)
  const loginUsernameRef = useRef(loginForm.username)
  const hostRestoreRetryRef = useRef(false)
  const suppressImmediateHostRestoreRef = useRef(false)

  const includePracticeTest = lessonPackage === "practice" || lessonPackage === "complete"
  const includePresentation = lessonPackage === "presentation" || lessonPackage === "complete"
  const selectedSuiteMode =
    sessionMode === "battle"
      ? "battle"
      : sessionMode === "math"
        ? "math"
        : includePresentation
          ? "presentation"
          : includePracticeTest
          ? "practice"
          : "lesson"
  const controlMode =
    sessionMode === "math"
      ? "math"
      : sessionMode === "battle"
        ? "battle"
        : "lesson"
  const activeWorkspaceMeta =
    HOST_WORKSPACE_OPTIONS.find((option) => option.id === hostWorkspace) || HOST_WORKSPACE_OPTIONS[0]
  const visibleManagementOptions = useMemo(
    () =>
      hostSession.canManageAccounts
        ? MANAGEMENT_PANEL_OPTIONS
        : MANAGEMENT_PANEL_OPTIONS.filter((option) => option.id !== "accounts"),
    [hostSession.canManageAccounts]
  )
  const activeManagementMeta =
    visibleManagementOptions.find((option) => option.id === managementPanel) || visibleManagementOptions[0]
  const primaryWorkspaceOptions = HOST_WORKSPACE_OPTIONS.filter((option) => option.id !== "management")
  const buildActionLabel =
    selectedSuiteMode === "math"
      ? "Rekenroute starten"
      : sessionMode === "battle"
      ? "Ronde klaarzetten"
      : selectedSuiteMode === "presentation"
        ? "Presentatie opbouwen"
        : selectedSuiteMode === "practice"
          ? "Oefentoets opbouwen"
          : "Les opbouwen"
  const currentPresentationSlide = game.lesson?.presentation?.currentSlide || null
  const liveWorkspaceId =
    game.mode === "battle"
      ? "battle"
      : game.mode === "math"
        ? "math"
        : game.mode === "lesson"
          ? "lesson"
          : ""
  const liveWorkspaceLabel = liveWorkspaceId
    ? HOST_WORKSPACE_OPTIONS.find((option) => option.id === liveWorkspaceId)?.label || "live sessie"
    : ""
  const liveStatusText =
    game.mode === "lesson"
      ? game.status === "finished"
        ? "Les afgerond"
        : game.totalPhases
          ? `${game.totalPhases} lesstappen klaar`
          : "Les nog niet gestart"
      : game.mode === "math"
        ? `${game.math?.players?.length || 0} leerlingen oefenen`
        : game.mode === "battle"
          ? game.status === "finished"
            ? "Battle afgerond"
            : game.totalQuestions
              ? `${game.totalQuestions} vragen klaar`
              : "Battle nog niet gestart"
        : "Nog geen live sessie"
  const classroomJoinUrl = useMemo(
    () => buildClassroomJoinUrl(hostSession.roomCode),
    [hostSession.roomCode]
  )
  const classroomJoinQrUrl = useMemo(
    () => buildQrCodeImageUrl(classroomJoinUrl, 240),
    [classroomJoinUrl]
  )
  const classroomJoinQrLargeUrl = useMemo(
    () => buildQrCodeImageUrl(classroomJoinUrl, 720),
    [classroomJoinUrl]
  )
  const battleAnswerWindowExpired =
    game.mode === "battle" &&
    game.source !== "practice" &&
    game.question &&
    game.status === "live" &&
    (timeLeft === 0 || Boolean(hostInsights?.answerWindowExpired))
  const canRevealBattleAnswer =
    game.mode === "battle" &&
    game.source !== "practice" &&
    game.question &&
    game.status === "live" &&
    (Boolean(hostInsights?.allAnswered) || battleAnswerWindowExpired)
  const battleRevealHelperText =
    game.mode !== "battle" || game.source === "practice" || !game.question || game.status !== "live"
      ? ""
      : hostInsights?.allAnswered
        ? "Iedereen heeft geantwoord. Je kunt nu het juiste antwoord tonen."
        : battleAnswerWindowExpired
          ? "De tijd is voorbij. Je kunt nu het juiste antwoord tonen."
          : `${hostInsights?.answeredCount || 0}/${hostInsights?.totalPlayers || 0} leerlingen hebben geantwoord. Het juiste antwoord blijft nog verborgen.`
  const recentSessionEntries = useMemo(() => sessionHistory.slice(0, 3), [sessionHistory])
  const lessonLibraryAudiences = useMemo(
    () => [...new Set(lessonLibrary.map((lesson) => String(lesson.audience || "").trim()).filter(Boolean))].sort(),
    [lessonLibrary]
  )
  const lessonLibrarySections = useMemo(
    () => [...new Set(lessonLibrary.map((lesson) => String(lesson.sectionName || "").trim()).filter(Boolean))].sort(),
    [lessonLibrary]
  )
  const lessonLibraryFolders = useMemo(
    () => [...new Set(lessonLibrary.map((lesson) => String(lesson.folderName || "").trim()).filter(Boolean))].sort(),
    [lessonLibrary]
  )
  const filteredLessonLibrary = useMemo(
    () =>
      lessonLibrary.filter((lesson) => {
        if (libraryAudienceFilter !== "all" && String(lesson.audience || "").trim() !== libraryAudienceFilter) return false
        if (librarySectionFilter !== "all" && String(lesson.sectionName || "").trim() !== librarySectionFilter) return false
        if (libraryFolderFilter !== "all" && String(lesson.folderName || "").trim() !== libraryFolderFilter) return false
        return matchesSearchTokens(
          [
            lesson.title,
            lesson.topic,
            lesson.lessonGoal,
            lesson.model,
            lesson.audience,
            lesson.sectionName,
            lesson.ownerDisplayName,
            lesson.folderName,
            ...(lesson.tags || []),
          ]
            .filter(Boolean)
            .join(" "),
          librarySearch
        )
      }),
    [lessonLibrary, libraryAudienceFilter, librarySectionFilter, libraryFolderFilter, librarySearch]
  )
  const historyCategories = useMemo(
    () => [...new Set(sessionHistory.map((entry) => String(entry.category || "").trim()).filter(Boolean))].sort(),
    [sessionHistory]
  )
  const filteredSessionHistory = useMemo(
    () =>
      sessionHistory.filter((entry) => {
        if (historyTypeFilter !== "all" && String(entry.type || "") !== historyTypeFilter) return false
        if (historyCategoryFilter !== "all" && String(entry.category || "").trim() !== historyCategoryFilter) return false
        return matchesSearchTokens(
          [entry.title, entry.topic, entry.lessonGoal, entry.category, entry.providerLabel, entry.audience].filter(Boolean).join(" "),
          historySearch
        )
      }),
    [historyCategoryFilter, historySearch, historyTypeFilter, sessionHistory]
  )
  const mathLearnerRows = useMemo(
    () => (hostInsights?.mode === "math" ? hostInsights.players || [] : game.math?.players || []),
    [game.math?.players, hostInsights]
  )
  const selectedMathClassroom = useMemo(
    () => classrooms.find((entry) => entry.id === selectedMathClassId) || null,
    [classrooms, selectedMathClassId]
  )
  const classroomAudiences = useMemo(
    () => [...new Set(classrooms.map((entry) => String(entry.audience || "").trim()).filter(Boolean))].sort(),
    [classrooms]
  )
  const filteredClassrooms = useMemo(
    () =>
      classrooms.filter((classroom) => {
        if (classroomAudienceFilter !== "all" && String(classroom.audience || "").trim() !== classroomAudienceFilter) return false
        return matchesSearchTokens(
          [
            classroom.name,
            classroom.sectionName,
            classroom.audience,
            classroom.ownerDisplayName,
            ...(classroom.learners || []).flatMap((learner) => [learner.name, learner.learnerCode, learner.studentNumber]),
          ]
            .filter(Boolean)
            .join(" "),
          classroomSearch
        )
      }),
    [classroomAudienceFilter, classroomSearch, classrooms]
  )
  const liveGroupModeEnabled = Boolean(game.groupModeEnabled)
  const canGoToPreviousLessonStep =
    game.mode === "lesson" &&
    ((Number.isInteger(game.currentPhaseIndex) && game.currentPhaseIndex > 0) ||
      (game.status === "finished" && Number(game.totalPhases) > 0))

  useEffect(() => {
    if (teams.length > 0 && !isEditingTeams) {
      setTeamNamesInput(teams.map((team) => team.name).join("\n"))
    }
  }, [teams, isEditingTeams])

  useEffect(() => {
    setGroupModeEnabledDraft(Boolean(game.groupModeEnabled))
  }, [game.groupModeEnabled])

  useEffect(() => {
    if (hostWorkspace !== "management") return
    if (visibleManagementOptions.some((option) => option.id === managementPanel)) return
    setManagementPanel(visibleManagementOptions[0]?.id || "learners")
  }, [hostWorkspace, managementPanel, visibleManagementOptions])

  useEffect(() => {
    if (!hostSession.authenticated) {
      setHostMenuOpen(false)
      setHostProfileOpen(false)
    }
  }, [hostSession.authenticated])

  useEffect(() => {
    if (!hostMenuOpen && !hostProfileOpen) return undefined
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setHostMenuOpen(false)
        setHostProfileOpen(false)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [hostMenuOpen, hostProfileOpen])

  useEffect(() => {
    if (game.lessonModel) setLessonModel(game.lessonModel)
    if (game.lessonDurationMinutes) setLessonDurationMinutes(game.lessonDurationMinutes)
  }, [game.lessonDurationMinutes, game.lessonModel])

  useEffect(() => {
    if (game.mode === "math" && sessionMode === "battle") {
      setSessionMode("math")
    }
    if (game.math?.selectedBand) {
      setMathBand(String(game.math.selectedBand).toLowerCase())
    }
  }, [game.math?.selectedBand, game.mode, sessionMode])

  useEffect(() => {
    if (game.mode !== "math") return
    setMathAssignmentTitle(game.math?.assignmentTitle || game.math?.title || "")
    setMathAssignmentDueAt(formatDateTimeLocalInput(game.math?.dueAt))
    setMathTargetPracticeCount(Number(game.math?.targetPracticeQuestionCount) || 12)
    setSelectedMathClassId(game.math?.classId || "")
  }, [game.math?.assignmentTitle, game.math?.classId, game.math?.dueAt, game.math?.targetPracticeQuestionCount, game.math?.title, game.mode])

  useEffect(() => {
    if (!selectedMathClassId) return
    if (classrooms.some((entry) => entry.id === selectedMathClassId)) return
    if (game.mode === "math" && game.math?.classId === selectedMathClassId) return
    setSelectedMathClassId("")
  }, [classrooms, game.math?.classId, game.mode, selectedMathClassId])

  useEffect(() => {
    if (game.mode !== "lesson") return
    setLessonPackage(
      lessonPackageFromFlags({
        includePracticeTest: Boolean(game.lesson?.includePracticeTest),
        includePresentation: Boolean(game.lesson?.includePresentation),
      })
    )
    setIncludeVideoPlan(Boolean(game.lesson?.includeVideoPlan))
  }, [game.lesson?.includePracticeTest, game.lesson?.includePresentation, game.lesson?.includeVideoPlan, game.mode])

  useEffect(() => {
    if (game.mode !== "lesson") return
    setLessonPromptDraft(game.lesson?.currentPhase?.prompt || "")
    setLessonExpectedAnswerDraft(game.lesson?.currentPhase?.expectedAnswer || "")
  }, [game.lesson?.currentPhase?.id, game.lesson?.currentPhase?.prompt, game.lesson?.currentPhase?.expectedAnswer, game.mode])

  useEffect(() => {
    const username = hostSession.username || loginForm.username
    setLocalRoomBackup(readHostRoomBackup(username))
  }, [hostSession.username, loginForm.username])

  useEffect(() => {
    setLibraryMetaDrafts((current) => {
      const nextDrafts = { ...current }
      for (const lesson of lessonLibrary) {
        nextDrafts[lesson.id] = {
          folderName: nextDrafts[lesson.id]?.folderName ?? lesson.folderName ?? "",
          sectionName: nextDrafts[lesson.id]?.sectionName ?? lesson.sectionName ?? "",
          tags: nextDrafts[lesson.id]?.tags ?? (Array.isArray(lesson.tags) ? lesson.tags.join(", ") : ""),
        }
      }
      return nextDrafts
    })
  }, [lessonLibrary])

  useEffect(() => {
    setClassroomDrafts((current) => {
      const nextDrafts = { ...current }
      for (const classroom of classrooms) {
        nextDrafts[classroom.id] = {
          name: nextDrafts[classroom.id]?.name ?? classroom.name ?? "",
          sectionName: nextDrafts[classroom.id]?.sectionName ?? classroom.sectionName ?? "",
          audience: nextDrafts[classroom.id]?.audience ?? classroom.audience ?? "vmbo",
        }
      }
      return nextDrafts
    })
    setClassroomLearnerDrafts((current) => {
      const nextDrafts = { ...current }
      for (const classroom of classrooms) {
        nextDrafts[classroom.id] = nextDrafts[classroom.id] || { name: "", learnerCode: "", studentNumber: "" }
      }
      return nextDrafts
    })
    setClassroomLearnerEditDrafts((current) => {
      const nextDrafts = { ...current }
      for (const classroom of classrooms) {
        for (const learner of classroom.learners || []) {
          nextDrafts[learner.id] = {
            name: nextDrafts[learner.id]?.name ?? learner.name ?? "",
            learnerCode: nextDrafts[learner.id]?.learnerCode ?? learner.learnerCode ?? "",
            studentNumber: nextDrafts[learner.id]?.studentNumber ?? learner.studentNumber ?? "",
          }
        }
      }
      return nextDrafts
    })
  }, [classrooms])

  useEffect(() => {
    hostSessionRef.current = hostSession
  }, [hostSession])

  useEffect(() => {
    loginUsernameRef.current = loginForm.username
  }, [loginForm.username])

  useEffect(() => {
    const onLoginSuccess = ({ username, displayName, role, canManageAccounts, roomCode, sessionToken }) => {
      hostRestoreRetryRef.current = false
      suppressImmediateHostRestoreRef.current = true
      writeHostLastRoomCode(username || loginUsernameRef.current, roomCode)
      setHostSession((current) => ({
        ...current,
        authenticated: true,
        username,
        displayName: displayName || username,
        role: role || "",
        canManageAccounts: Boolean(canManageAccounts),
        roomCode,
        sessionToken: sessionToken || "",
      }))
      setLoginForm((current) => ({
        ...current,
        username: username || current.username,
        password: "",
      }))
      setStatus("Beheeraccount verbonden.")
    }
    const onConfigureSuccess = ({ teams: nextTeams, groupModeEnabled: nextGroupModeEnabled }) => {
      const teamCount = Array.isArray(nextTeams) ? nextTeams.length : teams.length
      if (Array.isArray(nextTeams) && nextTeams.length > 0) {
        setTeamNamesInput(nextTeams.map((team) => team.name).join("\n"))
      }
      if (typeof nextGroupModeEnabled === "boolean") {
        setGroupModeEnabledDraft(nextGroupModeEnabled)
      }
      setIsEditingTeams(false)
      setStatus(
        nextGroupModeEnabled
          ? `${teamCount} groepen opgeslagen. Leerlingen mogen nu desgewenst een groep kiezen.`
          : "Individuele deelname staat aan. Leerlingen hoeven geen groep meer te kiezen."
      )
    }
    const onRoomUpdate = ({ roomCode }) => {
      const username = hostSessionRef.current.username || loginUsernameRef.current
      writeHostLastRoomCode(username, roomCode)
      setHostSession((current) => ({ ...current, roomCode }))
    }
    const onStarted = ({ message }) => setStatus(message)
    const onLessonStarted = ({ message }) => setStatus(message)
    const onClassesUpdate = ({ classrooms: nextClassrooms }) => setClassrooms(Array.isArray(nextClassrooms) ? nextClassrooms : [])
    const onLibraryUpdate = ({ lessons }) => setLessonLibrary(Array.isArray(lessons) ? lessons : [])
    const onHistoryUpdate = ({ entries }) => setSessionHistory(Array.isArray(entries) ? entries : [])
    const onTeacherAccountsUpdate = ({ accounts }) => setTeacherAccounts(Array.isArray(accounts) ? accounts : [])
    const onInsights = (payload) => {
      setHostInsights(payload)
      if (payload?.allAnswered && payload.totalPlayers > 0) {
        setStatus(
          payload.mode === "lesson"
            ? "Alle deelnemers hebben gereageerd. Je kunt naar de volgende lesstap."
            : "Alle deelnemers hebben geantwoord. Je kunt nu het juiste antwoord tonen."
        )
        return
      }
      if (payload?.mode === "battle" && payload?.canRevealAnswer && payload?.answerWindowExpired) {
        setStatus("De tijd is voorbij. Je kunt nu het juiste antwoord tonen.")
      }
    }
    const onError = ({ message }) => {
      const normalizedMessage = String(message || "")
      setSlideImageBusy(false)
      setClassroomImportBusyId("")
      setStatus(`Fout: ${normalizedMessage}`)

      if (/onjuiste docentgegevens/i.test(normalizedMessage)) {
        hostRestoreRetryRef.current = false
        setHostSession(DEFAULT_HOST_SESSION)
        return
      }

      if (/sessie verlopen|sessie niet meer geldig/i.test(normalizedMessage)) {
        const currentSession = hostSessionRef.current
        if (
          currentSession.authenticated &&
          currentSession.sessionToken &&
          !hostRestoreRetryRef.current
        ) {
          hostRestoreRetryRef.current = true
          socket.emit("host:restore-session", {
            sessionToken: currentSession.sessionToken,
            roomCode: currentSession.roomCode,
          })
          setStatus("Verbinding met het beheeraccount wordt opnieuw gekoppeld...")
          return
        }

        hostRestoreRetryRef.current = false
        setHostSession(DEFAULT_HOST_SESSION)
      }
    }
    const onSuccess = ({ count, providerLabel }) =>
      setStatus(
        providerLabel === "Adaptieve rekenroute"
          ? `De rekenroute staat live. Leerlingen krijgen eerst ${count} instapvragen en gaan daarna adaptief verder.`
          : `${count} AI-vragen klaar${providerLabel ? ` via ${providerLabel}` : ""}. De eerste vraag staat klaar in docent-preview. Klik op Start vraag om hem live te zetten.`
      )
    const onLessonSuccess = ({ count, providerLabel, lessonModel: nextLessonModel, hasPracticeTest, hasPresentation }) =>
      setStatus(
        `${count} lesstappen klaar${providerLabel ? ` via ${providerLabel}` : ""}. ${String(nextLessonModel || "Lesmodus").toUpperCase()} is live.${hasPracticeTest ? " Oefentoets klaar." : ""}${hasPresentation ? " Presentatiepakket klaar." : ""}`
      )
    const onLessonPromptSuccess = () => setStatus("Live lesvraag bijgewerkt voor de deelnemers.")
    const onSaveLessonSuccess = ({ title }) => setStatus(`Les opgeslagen in de bibliotheek: ${title}.`)
    const onLoadLessonSuccess = ({ title }) => {
      setSessionMode("lesson")
      setStatus(`Les geladen uit de bibliotheek: ${title}.`)
    }
    const onDeleteLessonSuccess = () => setStatus("Les verwijderd uit de bibliotheek.")
    const onFavoriteLessonSuccess = ({ title, isFavorite }) =>
      setStatus(`${title || "Les"} ${isFavorite ? "staat nu als favoriet gemarkeerd." : "is uit de favorieten gehaald."}`)
    const onUpdateLessonMetaSuccess = ({ title }) => setStatus(`Map en tags bijgewerkt voor ${title || "de les"}.`)
    const onHistoryLoadSuccess = ({ title, type }) =>
      setStatus(`${type === "lesson" ? "Les" : type === "practice" ? "Oefentoets" : "Quiz"} geladen uit geschiedenis: ${title}.`)
    const onHistoryDeleteSuccess = () => setStatus("Geschiedenis-item verwijderd.")
    const onTeacherAccountsSuccess = ({ message }) => {
      setTeacherAccountForm((current) => ({ ...current, username: "", displayName: "", password: "" }))
      setTeacherPasswordDrafts({})
      setStatus(message || "Docentaccounts bijgewerkt.")
    }
    const onLearnerCodeSuccess = ({ message }) => {
      setNewMathLearner({ name: "", learnerCode: "" })
      setStatus(message || "Leercode bijgewerkt.")
    }
    const onClassesSuccess = ({ message }) => {
      setNewClassroomForm((current) => ({ ...current, name: "" }))
      setClassroomImportBusyId("")
      setStatus(message || "Klassen zijn bijgewerkt.")
    }
    const onPresentationImageSuccess = ({ manualImageUrl, imageAlt, sourceTitle, searchAttempt }) => {
      hostRestoreRetryRef.current = false
      setSlideImageBusy(false)
      setManualSlideImageUrlDraft(manualImageUrl || "")
      if (typeof imageAlt === "string") setManualSlideImageAltDraft(imageAlt)
      setManualSlideUploadName("")
      setStatus(
        manualImageUrl
          ? sourceTitle
            ? `Dia-afbeelding bijgewerkt${searchAttempt ? ` (poging ${searchAttempt})` : ""}: ${sourceTitle}.`
            : "Dia-afbeelding bijgewerkt."
          : "Handmatige dia-afbeelding verwijderd."
      )
    }
    const onRoomBackup = ({ snapshot }) => {
      const username = hostSessionRef.current.username || loginUsernameRef.current
      const storedBackup = writeHostRoomBackup(username, snapshot)
      if (storedBackup) setLocalRoomBackup(storedBackup)
    }
    const onBackupRestoreSuccess = ({ roomCode, title }) => {
      const username = hostSessionRef.current.username || loginUsernameRef.current
      writeHostLastRoomCode(username, roomCode)
      setStatus(`Lokale backup hersteld${title ? `: ${title}` : ""}. Sessiecode ${roomCode}.`)
    }

    socket.on("host:login:success", onLoginSuccess)
    socket.on("host:configure:success", onConfigureSuccess)
    socket.on("host:room:update", onRoomUpdate)
    socket.on("host:generate:started", onStarted)
    socket.on("host:generate-lesson:started", onLessonStarted)
    socket.on("host:classes:update", onClassesUpdate)
    socket.on("host:lesson-library:update", onLibraryUpdate)
    socket.on("host:session-history:update", onHistoryUpdate)
    socket.on("host:teacher-accounts:update", onTeacherAccountsUpdate)
    socket.on("host:question:insights", onInsights)
    socket.on("host:error", onError)
    socket.on("host:generate:success", onSuccess)
    socket.on("host:generate-lesson:success", onLessonSuccess)
    socket.on("host:lesson-prompt:success", onLessonPromptSuccess)
    socket.on("host:save-lesson:success", onSaveLessonSuccess)
    socket.on("host:load-lesson:success", onLoadLessonSuccess)
    socket.on("host:delete-lesson:success", onDeleteLessonSuccess)
    socket.on("host:lesson-library:favorite:success", onFavoriteLessonSuccess)
    socket.on("host:lesson-library:update-meta:success", onUpdateLessonMetaSuccess)
    socket.on("host:history:load:success", onHistoryLoadSuccess)
    socket.on("host:history:delete:success", onHistoryDeleteSuccess)
    socket.on("host:teacher-accounts:success", onTeacherAccountsSuccess)
    socket.on("host:learner-code:success", onLearnerCodeSuccess)
    socket.on("host:classes:success", onClassesSuccess)
    socket.on("host:presentation-image:success", onPresentationImageSuccess)
    socket.on("host:room:backup", onRoomBackup)
    socket.on("host:backup:restore:success", onBackupRestoreSuccess)

    return () => {
      socket.off("host:login:success", onLoginSuccess)
      socket.off("host:configure:success", onConfigureSuccess)
      socket.off("host:room:update", onRoomUpdate)
      socket.off("host:generate:started", onStarted)
      socket.off("host:generate-lesson:started", onLessonStarted)
      socket.off("host:classes:update", onClassesUpdate)
      socket.off("host:lesson-library:update", onLibraryUpdate)
      socket.off("host:session-history:update", onHistoryUpdate)
      socket.off("host:teacher-accounts:update", onTeacherAccountsUpdate)
      socket.off("host:question:insights", onInsights)
      socket.off("host:error", onError)
      socket.off("host:generate:success", onSuccess)
      socket.off("host:generate-lesson:success", onLessonSuccess)
      socket.off("host:lesson-prompt:success", onLessonPromptSuccess)
      socket.off("host:save-lesson:success", onSaveLessonSuccess)
      socket.off("host:load-lesson:success", onLoadLessonSuccess)
      socket.off("host:delete-lesson:success", onDeleteLessonSuccess)
      socket.off("host:lesson-library:favorite:success", onFavoriteLessonSuccess)
      socket.off("host:lesson-library:update-meta:success", onUpdateLessonMetaSuccess)
      socket.off("host:history:load:success", onHistoryLoadSuccess)
      socket.off("host:history:delete:success", onHistoryDeleteSuccess)
      socket.off("host:teacher-accounts:success", onTeacherAccountsSuccess)
      socket.off("host:learner-code:success", onLearnerCodeSuccess)
      socket.off("host:classes:success", onClassesSuccess)
      socket.off("host:presentation-image:success", onPresentationImageSuccess)
      socket.off("host:room:backup", onRoomBackup)
      socket.off("host:backup:restore:success", onBackupRestoreSuccess)
    }
  }, [])

  useEffect(() => {
    setManualSlideImageUrlDraft(currentPresentationSlide?.manualImageUrl || "")
    setManualSlideImageAltDraft(currentPresentationSlide?.imageAlt || currentPresentationSlide?.title || "")
    setManualSlideUploadName("")
  }, [currentPresentationSlide?.id, currentPresentationSlide?.manualImageUrl, currentPresentationSlide?.imageAlt, currentPresentationSlide?.title])

  useEffect(() => {
    if (!slideImageBusy) return undefined
    const timer = window.setTimeout(() => {
      setSlideImageBusy(false)
      setStatus((current) =>
        String(current || "").includes("Fout:")
          ? current
          : "Zoeken of uploaden duurde te lang. Probeer opnieuw of kies een andere dia-afbeelding."
      )
    }, 18000)
    return () => window.clearTimeout(timer)
  }, [slideImageBusy])

  useEffect(() => {
    if (!game.math?.players?.length) return
    setLearnerCodeDrafts((current) => {
      const nextDrafts = { ...current }
      for (const player of game.math.players) {
        if (!nextDrafts[player.playerId]) {
          nextDrafts[player.playerId] = player.learnerCode || ""
        }
      }
      return nextDrafts
    })
  }, [game.math?.players])

  useEffect(() => {
    window.sessionStorage.setItem(
      HOST_SESSION_KEY,
      JSON.stringify({
        authenticated: hostSession.authenticated,
        username: hostSession.username,
        displayName: hostSession.displayName,
        role: hostSession.role,
        canManageAccounts: hostSession.canManageAccounts,
        roomCode: hostSession.roomCode,
        sessionToken: hostSession.sessionToken,
        lastUsername: loginForm.username,
      })
    )
  }, [
    hostSession.authenticated,
    hostSession.canManageAccounts,
    hostSession.displayName,
    hostSession.role,
    hostSession.roomCode,
    hostSession.sessionToken,
    hostSession.username,
    loginForm.username,
  ])

  useEffect(() => {
    const reconnectHost = () => {
      const currentSession = hostSessionRef.current
      if (!currentSession.authenticated || !currentSession.username || !currentSession.sessionToken) return
      socket.emit("host:restore-session", {
        sessionToken: currentSession.sessionToken,
        roomCode: currentSession.roomCode,
      })
    }

    if (hostSession.authenticated && hostSession.sessionToken && socket.connected) {
      if (suppressImmediateHostRestoreRef.current) {
        suppressImmediateHostRestoreRef.current = false
      } else {
        reconnectHost()
      }
    }

    socket.on("connect", reconnectHost)
    return () => socket.off("connect", reconnectHost)
  }, [hostSession.authenticated, hostSession.sessionToken])

  useEffect(() => {
    if (!game.question) {
      setHostInsights(null)
    }
  }, [game.question?.id])

  const timeLeft = useQuestionCountdown(game)
  const [presenterMode, setPresenterMode] = useState(false)
  const [presenterFullscreen, setPresenterFullscreen] = useState(false)
  const [battleDurationDraft, setBattleDurationDraft] = useState(questionDurationSec)
  const onlinePlayerCount = useMemo(
    () => players.filter((player) => player.connected !== false).length,
    [players]
  )

  const openPresenterMode = async () => {
    const hasLessonBoard = game.mode === "lesson" && Boolean(game.lesson?.presentation?.currentSlide)
    const hasBattleBoard = game.mode === "battle" && Boolean(game.question)

    if (!hasLessonBoard && !hasBattleBoard) {
      setStatus("Zet eerst een lesdia of battlevraag klaar voordat je digibordmodus opent.")
      return
    }

    setPresenterMode(true)
    setHostProfileOpen(false)
    setJoinQrOpen(false)

    if (document.fullscreenElement) {
      setPresenterFullscreen(true)
      return
    }

    try {
      await document.documentElement.requestFullscreen()
      setPresenterFullscreen(true)
    } catch (error) {
      console.warn("Fullscreen kon niet worden gestart:", error)
      setStatus("Digibordweergave geopend. Schermvullend werd niet gestart, maar de weergave staat wel open.")
      setPresenterFullscreen(false)
    }
  }

  const closePresenterMode = async () => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen()
      } catch (error) {
        console.warn("Fullscreen kon niet netjes worden afgesloten:", error)
      }
    }

    setPresenterMode(false)
    setPresenterFullscreen(false)
  }

  const togglePresenterMode = () => {
    if (presenterMode) {
      closePresenterMode()
      return
    }

    openPresenterMode()
  }

  useEffect(() => {
    const syncFullscreen = () => setPresenterFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener("fullscreenchange", syncFullscreen)
    return () => document.removeEventListener("fullscreenchange", syncFullscreen)
  }, [])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Escape" || !presenterMode || document.fullscreenElement) return
      setPresenterMode(false)
      setPresenterFullscreen(false)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [presenterMode])

  useEffect(() => {
    if (game.mode !== "battle" || !game.question) return
    setBattleDurationDraft(game.question.durationSec || game.questionDurationSec || 20)
  }, [game.mode, game.question?.id, game.question?.durationSec, game.questionDurationSec])

  useEffect(() => {
    if (!presenterMode) return
    const hasLessonBoard = game.mode === "lesson" && Boolean(game.lesson?.presentation?.currentSlide)
    const hasBattleBoard = game.mode === "battle" && Boolean(game.question)
    if (!hasLessonBoard && !hasBattleBoard) {
      closePresenterMode()
    }
  }, [game.lesson?.presentation?.currentSlide?.id, game.mode, game.question?.id, presenterMode])

  const preparedTeamNames = useMemo(
    () =>
      teamNamesInput
        .split(/\n|,/)
        .map((name) => name.trim())
        .filter(Boolean),
    [teamNamesInput]
  )

  const configureTeams = () => {
    setStatus("Groepsinstellingen worden bijgewerkt...")
    socket.emit("host:configure", {
      teamNames: preparedTeamNames,
      groupModeEnabled: groupModeEnabledDraft,
    })
  }

  const selectSessionMode = (nextMode) => {
    if (nextMode === "battle") {
      setSessionMode("battle")
      return
    }

    if (nextMode === "math") {
      setSessionMode("math")
      return
    }

    setSessionMode(nextMode)

    if (nextMode === "lesson") {
      setLessonPackage("lesson")
      return
    }

    if (nextMode === "presentation") {
      setLessonPackage("presentation")
      return
    }

    if (nextMode === "practice") {
      setLessonPackage("practice")
      setIncludeVideoPlan(false)
    }
  }

  const openHostWorkspace = (nextWorkspace) => {
    setHostWorkspace(nextWorkspace)
    setHostMenuOpen(false)
    setHostProfileOpen(false)
    setJoinQrOpen(false)
    if (nextWorkspace === "home") return
    if (nextWorkspace === "management") return
    selectSessionMode(nextWorkspace)
  }

  const openSupportMail = () => {
    setStatus("Je mailapp wordt geopend voor een vraag of opmerking.")
  }

  const login = () => {
    setStatus("Inloggegevens controleren...")
    const normalizedUsername = String(loginForm.username || "").trim()
    const rememberedRoomCode =
      readHostLastRoomCode(normalizedUsername) || readHostRoomBackup(normalizedUsername)?.roomCode || ""
    socket.emit("host:login", { ...loginForm, roomCode: rememberedRoomCode })
  }

  const logout = () => {
    const rememberedUsername = hostSession.username || loginForm.username
    hostRestoreRetryRef.current = false
    suppressImmediateHostRestoreRef.current = false
    socket.emit("host:logout")
    window.sessionStorage.removeItem(HOST_SESSION_KEY)
    setHostSession(DEFAULT_HOST_SESSION)
    setJoinQrOpen(false)
    setPresenterMode(false)
    setPresenterFullscreen(false)
    setLoginForm({ username: rememberedUsername || "", password: "" })
    setTeacherAccounts([])
    setStatus("Je bent uitgelogd.")
  }

  const generate = () => {
    setStatus("AI bouwt de nieuwe ronde op...")
    socket.emit("host:generate", {
      topic,
      audience,
      questionCount,
      questionDurationSec,
      teamNames: preparedTeamNames,
      groupModeEnabled: groupModeEnabledDraft,
    })
  }

  const generateMathSession = () => {
    setStatus("Adaptieve rekenroute wordt klaargezet...")
    socket.emit("host:start-math", {
      band: mathBand,
      assignmentTitle: mathAssignmentTitle,
      dueAt: mathAssignmentDueAt ? new Date(mathAssignmentDueAt).toISOString() : "",
      classId: selectedMathClassId,
      targetPracticeQuestionCount: mathTargetPracticeCount,
    })
  }

  const startBattleQuestion = () => {
    setStatus("Vraag wordt live gezet...")
    socket.emit("host:start-question", { durationSec: battleDurationDraft })
  }

  const showBattleAnswer = () => {
    setStatus("Juiste antwoord wordt getoond...")
    socket.emit("host:show-answer")
  }

  const generateLesson = () => {
    setStatus("AI bouwt de lesopzet op...")
    socket.emit("host:generate-lesson", {
      topic,
      audience,
      lessonModel,
      durationMinutes: lessonDurationMinutes,
      slideCount: presentationSlideCount,
      practiceQuestionCount,
      practiceQuestionFormat,
      includePracticeTest,
      includePresentation,
      includeVideoPlan: includePresentation && includeVideoPlan,
      teamNames: preparedTeamNames,
      groupModeEnabled: groupModeEnabledDraft,
    })
  }

  const goToNextStep = () => {
    if (game.mode === "lesson") {
      socket.emit("host:lesson-next")
      return
    }
    socket.emit("host:next")
  }

  const goToPreviousStep = () => {
    if (game.mode !== "lesson") return
    socket.emit("host:lesson-prev")
  }

  const saveCurrentLesson = () => {
    setStatus("Les wordt opgeslagen in de bibliotheek...")
    socket.emit("host:save-lesson")
  }

  const startPracticeTest = () => {
    setStatus("Oefentoets wordt live gezet...")
    socket.emit("host:start-practice-test")
  }

  const loadLessonFromLibrary = (lessonId) => {
    setStatus("Les wordt geladen uit de bibliotheek...")
    socket.emit("host:load-lesson", { lessonId })
  }

  const deleteLessonFromLibrary = (lessonId) => {
    setStatus("Les wordt verwijderd uit de bibliotheek...")
    socket.emit("host:delete-lesson", { lessonId })
  }

  const toggleLessonFavorite = (lessonId, isFavorite) => {
    setStatus(isFavorite ? "Les wordt als favoriet gemarkeerd..." : "Les wordt uit favorieten gehaald...")
    socket.emit("host:lesson-library:favorite", { lessonId, isFavorite })
  }

  const updateLessonLibraryMeta = (lessonId) => {
    const draft = libraryMetaDrafts[lessonId] || { folderName: "", sectionName: "", tags: "" }
    setStatus("Sectie, map en tags worden opgeslagen...")
    socket.emit("host:lesson-library:update-meta", {
      lessonId,
      folderName: draft.folderName,
      sectionName: draft.sectionName,
      tags: draft.tags
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    })
  }

  const loadSessionFromHistory = (entryId) => {
    setStatus("Sessie wordt geladen uit geschiedenis...")
    socket.emit("host:history:load", { entryId })
  }

  const deleteSessionFromHistory = (entryId) => {
    setStatus("Geschiedenis-item wordt verwijderd...")
    socket.emit("host:history:delete", { entryId })
  }

  const createTeacherAccount = () => {
    setStatus("Docentaccount wordt toegevoegd...")
    socket.emit("host:teacher-accounts:create", teacherAccountForm)
  }

  const updateTeacherAccount = (account) => {
    setStatus("Docentaccount wordt bijgewerkt...")
    socket.emit("host:teacher-accounts:update", {
      accountId: account.id,
      displayName: account.displayName,
      role: account.role,
      password: teacherPasswordDrafts[account.id] || "",
    })
  }

  const deleteTeacherAccount = (accountId) => {
    setStatus("Docentaccount wordt verwijderd...")
    socket.emit("host:teacher-accounts:delete", { accountId })
  }

  const updateLearnerCode = (playerId) => {
    const learnerCode = learnerCodeDrafts[playerId] || ""
    setStatus("Leercode wordt bijgewerkt...")
    socket.emit("host:learner-code:update", { playerId, learnerCode })
  }

  const createMathLearner = () => {
    setStatus("Leerling met code wordt klaargezet...")
    socket.emit("host:math:learner:create", newMathLearner)
  }

  const createClassroom = () => {
    setStatus("Klas wordt toegevoegd...")
    socket.emit("host:classes:create", newClassroomForm)
  }

  const updateClassroom = (classId) => {
    const draft = classroomDrafts[classId]
    if (!draft) return
    setStatus("Klas wordt bijgewerkt...")
    socket.emit("host:classes:update", {
      classId,
      name: draft.name,
      sectionName: draft.sectionName,
      audience: draft.audience,
    })
  }

  const deleteClassroom = (classId) => {
    setStatus("Klas wordt verwijderd...")
    socket.emit("host:classes:delete", { classId })
  }

  const addLearnerToClassroom = (classId) => {
    const draft = classroomLearnerDrafts[classId] || { name: "", learnerCode: "", studentNumber: "" }
    setStatus("Leerling wordt aan de klas toegevoegd...")
    socket.emit("host:classes:learner:add", {
      classId,
      name: draft.name,
      learnerCode: draft.learnerCode,
      studentNumber: draft.studentNumber,
    })
    setClassroomLearnerDrafts((current) => ({
      ...current,
      [classId]: { name: "", learnerCode: "", studentNumber: "" },
    }))
  }

  const saveClassroomLearner = (classId, learnerId) => {
    const draft = classroomLearnerEditDrafts[learnerId]
    if (!draft) return
    setStatus("Leerlinggegevens worden bijgewerkt...")
    socket.emit("host:classes:learner:update", {
      classId,
      learnerId,
      name: draft.name,
      learnerCode: draft.learnerCode,
      studentNumber: draft.studentNumber,
    })
  }

  const importLearnersIntoClassroom = async (classId, file) => {
    if (!file) return
    if (file.size > MAX_CLASSROOM_IMPORT_FILE_BYTES) {
      setStatus("Dit bestand is te groot. Gebruik een Excel- of CSV-bestand tot ongeveer 6 MB.")
      return
    }

    try {
      setClassroomImportBusyId(classId)
      setStatus("Leerlingenbestand wordt ingelezen...")
      const buffer = await readFileAsArrayBuffer(file)
      const fileDataBase64 = arrayBufferToBase64(buffer)
      socket.emit("host:classes:import", {
        classId,
        fileName: file.name,
        fileDataBase64,
      })
    } catch (error) {
      setClassroomImportBusyId("")
      setStatus(error instanceof Error ? error.message : "Het leerlingenbestand kon niet worden gelezen.")
    }
  }

  const deleteClassroomLearner = (classId, learnerId) => {
    setStatus("Leerling wordt uit de klas verwijderd...")
    socket.emit("host:classes:learner:delete", { classId, learnerId })
  }

  const restoreLocalRoomBackup = () => {
    if (!localRoomBackup?.snapshot) {
      setStatus("Er is geen lokale backup gevonden om te herstellen.")
      return
    }
    setStatus("Lokale backup wordt teruggezet...")
    socket.emit("host:backup:restore", { snapshot: localRoomBackup.snapshot })
  }

  const clearLocalRoomBackupFromDevice = () => {
    const username = hostSession.username || loginForm.username
    clearHostRoomBackup(username)
    setLocalRoomBackup(null)
    setStatus("Lokale backup verwijderd van dit apparaat.")
  }

  const exportLessonLibraryCsv = () => {
    if (!filteredLessonLibrary.length) {
      setStatus("Er zijn geen lessen zichtbaar om te exporteren.")
      return
    }
    downloadCsvFile(
      `lessonbattle-bibliotheek-${slugifyFilePart(hostSession.roomCode || "sessie") || "export"}.csv`,
      ["Titel", "Onderwerp", "Sectie", "Eigenaar", "Map", "Tags", "Doelgroep", "Model", "Duur (min)", "Fasen", "Oefenvragen", "Dia's", "Favoriet", "Laatst bijgewerkt"],
      filteredLessonLibrary.map((lesson) => [
        lesson.title,
        lesson.topic,
        lesson.sectionName || "",
        lesson.ownerDisplayName || "",
        lesson.folderName || "",
        (lesson.tags || []).join(", "),
        lesson.audience,
        lesson.model,
        lesson.durationMinutes,
        lesson.phaseCount,
        lesson.practiceQuestionCount || 0,
        lesson.slideCount || 0,
        lesson.isFavorite ? "ja" : "nee",
        formatHistoryDate(lesson.updatedAt),
      ])
    )
    setStatus("Bibliotheek geëxporteerd als CSV.")
  }

  const exportSessionHistoryCsv = () => {
    if (!filteredSessionHistory.length) {
      setStatus("Er zijn geen sessies zichtbaar om te exporteren.")
      return
    }
    downloadCsvFile(
      `lessonbattle-geschiedenis-${slugifyFilePart(hostSession.roomCode || "sessie") || "export"}.csv`,
      ["Titel", "Type", "Categorie", "Onderwerp", "Doelgroep", "Vragen", "Fasen", "Oefenvragen", "Dia's", "Bron", "Laatst bijgewerkt"],
      filteredSessionHistory.map((entry) => [
        entry.title,
        entry.type === "lesson" ? "Les" : entry.type === "practice" ? "Oefentoets" : "Battle",
        entry.category,
        entry.topic,
        entry.audience,
        entry.questionCount || 0,
        entry.phaseCount || 0,
        entry.practiceQuestionCount || 0,
        entry.slideCount || 0,
        entry.providerLabel,
        formatHistoryDate(entry.updatedAt),
      ])
    )
    setStatus("Sessiegeschiedenis geëxporteerd als CSV.")
  }

  const exportClassroomsCsv = () => {
    if (!filteredClassrooms.length) {
      setStatus("Er zijn geen klassen zichtbaar om te exporteren.")
      return
    }
    downloadCsvFile(
      `lessonbattle-klassen-${slugifyFilePart(hostSession.roomCode || "school") || "export"}.csv`,
      ["Klas", "Sectie", "Doelgroep", "Eigenaar", "Leerling", "Leerlingnummer", "Leerlingcode", "Aangemaakt", "Laatst bijgewerkt"],
      filteredClassrooms.flatMap((classroom) => {
        const learners = classroom.learners?.length
          ? classroom.learners
          : [{ id: `${classroom.id}-empty`, name: "", studentNumber: "", learnerCode: "", createdAt: "", updatedAt: "" }]
        return learners.map((learner) => [
          classroom.name,
          classroom.sectionName || "",
          classroom.audience || "",
          classroom.ownerDisplayName || "",
          learner.name || "",
          learner.studentNumber || "",
          learner.learnerCode || "",
          learner.createdAt ? formatHistoryDate(learner.createdAt) : "",
          learner.updatedAt ? formatHistoryDate(learner.updatedAt) : "",
        ])
      })
    )
    setStatus("Klassen en leerlingcodes geëxporteerd als CSV.")
  }

  const exportLearnersCsv = () => {
    const rows =
      game.mode === "math"
        ? mathLearnerRows.map((player) => [
            game.math?.assignmentTitle || game.math?.title || "",
            game.math?.dueAt ? formatHistoryDate(game.math.dueAt) : "",
            game.math?.className || "",
            player.name || "",
            player.learnerCode || "",
            player.connected ? "online" : "offline",
            player.assignmentStatus?.label || "",
            player.phase === "practice" ? "Adaptief oefenen" : "Instaptoets",
            player.placementLevel || "",
            player.targetLevel || "",
            player.answeredCount || 0,
            player.correctCount || 0,
            player.wrongCount || 0,
            formatAccuracy(player.accuracyRate || 0),
            (player.focusDomains || []).map(formatMathDomainLabel).join(", "),
            player.workLabel || "",
            player.growthSummary?.sessionCount || 0,
            player.growthSummary?.averageAccuracy ? `${player.growthSummary.averageAccuracy}%` : "",
            player.growthSummary?.lastPracticedAt ? formatHistoryDate(player.growthSummary.lastPracticedAt) : "",
            player.lastAnsweredAt ? formatHistoryDate(player.lastAnsweredAt) : "",
          ])
        : players.map((player) => [
            player.name || "",
            player.learnerCode || "",
            player.connected ? "online" : "offline",
            liveGroupModeEnabled ? teams.find((team) => team.id === player.teamId)?.name || "Geen groep" : "Individueel",
            player.score || 0,
            game.mode === "lesson" ? "Les" : game.mode === "battle" ? "Battle/Oefentoets" : "Sessie",
          ])

    if (!rows.length) {
      setStatus("Er zijn nog geen leerlingen zichtbaar om te exporteren.")
      return
    }

    const headers =
      game.mode === "math"
        ? ["Opdracht", "Deadline", "Klas", "Naam", "Leerlingcode", "Status", "Opdrachtstatus", "Fase", "Plaatsing", "Oefenniveau", "Gemaakt", "Goed", "Fout", "Nauwkeurigheid", "Focusdomeinen", "Werkhouding", "Geoefende routes", "Gemiddelde groei", "Laatst geoefend", "Laatste actief"]
        : ["Naam", "Leerlingcode", "Status", "Groep", "Score", "Modus"]

    downloadCsvFile(
      `lessonbattle-leerlingen-${slugifyFilePart(hostSession.roomCode || "sessie") || "export"}.csv`,
      headers,
      rows
    )
    setStatus("Leerlingoverzicht geëxporteerd als CSV.")
  }

  const updateLessonPrompt = () => {
    setStatus("Live lesvraag wordt bijgewerkt...")
    socket.emit("host:lesson-prompt:update", {
      prompt: lessonPromptDraft,
      expectedAnswer: lessonExpectedAnswerDraft,
    })
  }

  const saveManualSlideImageUrl = () => {
    if (!currentPresentationSlide?.id) {
      setStatus("Er is nu geen actieve dia om een afbeelding aan te koppelen.")
      return
    }
    setSlideImageBusy(true)
    setStatus("Dia-afbeelding wordt bijgewerkt...")
    socket.emit("host:presentation-image:update", {
      slideId: currentPresentationSlide.id,
      imageUrl: manualSlideImageUrlDraft,
      imageAlt: manualSlideImageAltDraft,
    })
  }

  const autoFindSlideImage = () => {
    if (!currentPresentationSlide?.id) {
      setStatus("Er is nu geen actieve dia om automatisch een afbeelding voor te zoeken.")
      return
    }
    setSlideImageBusy(true)
    setStatus("Site zoekt nu een passende internetafbeelding voor deze dia...")
    socket.emit("host:presentation-image:auto", {
      slideId: currentPresentationSlide.id,
    })
  }

  const clearManualSlideImage = () => {
    if (!currentPresentationSlide?.id) {
      setStatus("Er is nu geen actieve dia om een afbeelding te wissen.")
      return
    }
    setSlideImageBusy(true)
    setStatus("Handmatige dia-afbeelding wordt verwijderd...")
    socket.emit("host:presentation-image:clear", {
      slideId: currentPresentationSlide.id,
    })
  }

  const uploadManualSlideImage = async (file) => {
    if (!currentPresentationSlide?.id || !file) return
    setManualSlideUploadName(file.name || "upload")
    setSlideImageBusy(true)
    setStatus("Afbeelding wordt geoptimaliseerd en geupload...")

    try {
      const optimizedDataUrl = await optimizeImageFile(file)
      const response = await fetch("/api/host/presentation-image-upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionToken: hostSession.sessionToken,
          slideId: currentPresentationSlide.id,
          uploadDataUrl: optimizedDataUrl,
          imageAlt: manualSlideImageAltDraft,
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.message || "Uploaden van de afbeelding is mislukt.")
      }
      setManualSlideImageUrlDraft(payload?.manualImageUrl || "")
      if (typeof payload?.imageAlt === "string") setManualSlideImageAltDraft(payload.imageAlt)
      setManualSlideUploadName("")
      setSlideImageBusy(false)
      setStatus("Dia-afbeelding bijgewerkt.")
    } catch (error) {
      setSlideImageBusy(false)
      setManualSlideUploadName("")
      setStatus(error instanceof Error ? error.message : "Uploaden van de afbeelding is mislukt.")
    }
  }

  const isManagementWorkspace = hostWorkspace === "management"
  const isHomeWorkspace = hostWorkspace === "home"

  return (
    <main className="page-shell host-shell">
      {!hostSession.authenticated ? (
        <>
          <section className="hero-card host-login-hero">
            <div className="hero-copy">
              <span className="eyebrow">Docentenomgeving</span>
              <h1>Werk rustig, helder en zonder overvol dashboard.</h1>
              <p>
                Lesson Battle helpt je om lessen, presentaties, battles en rekenroutes op te bouwen vanuit één rustige
                werkplek. Na het inloggen kies je via het menu alleen het onderdeel dat je op dat moment nodig hebt.
              </p>
              <div className="hero-tags">
                <span>Les opbouwen</span>
                <span>Presenteren</span>
                <span>Battle starten</span>
                <span>Rekenen volgen</span>
              </div>
            </div>
            <div className="hero-panel glass">
              <div className="hero-stat">
                <strong>Rustig</strong>
                <span>Minder afleiding op je scherm</span>
              </div>
              <div className="hero-stat">
                <strong>Snel</strong>
                <span>Werkruimtes via het menu</span>
              </div>
              <div className="hero-stat">
                <strong>Direct</strong>
                <span>Digibord, presentatie en oefenroutes</span>
              </div>
            </div>
          </section>
          <section className="glass control-card login-card">
            <div className="section-head">
              <h2>Docentenlogin</h2>
              <span className="pill">{status}</span>
            </div>
            <div className="field-row">
              <label className="field">
                <span>Gebruikersnaam</span>
                <input
                  value={loginForm.username}
                  onChange={(event) => setLoginForm((current) => ({ ...current, username: event.target.value }))}
                  placeholder="bijv. j.devries"
                />
              </label>
              <label className="field">
                <span>Wachtwoord</span>
                <input
                  type="password"
                  value={loginForm.password}
                  onChange={(event) => setLoginForm((current) => ({ ...current, password: event.target.value }))}
                  placeholder="wachtwoord"
                />
              </label>
            </div>
            <div className="action-row single-action">
              <button className="button-primary" onClick={login} type="button">
                Inloggen
              </button>
            </div>
          </section>
        </>
      ) : null}

      {hostSession.authenticated ? (
        <>
          <header className="glass host-header">
            <div className="host-header-main">
              <button
                aria-expanded={hostMenuOpen}
                aria-label="Open werkruimtes"
                className={`host-menu-button ${hostMenuOpen ? "is-open" : ""}`}
                onClick={() => setHostMenuOpen((current) => !current)}
                type="button"
              >
                <span />
                <span />
                <span />
              </button>
              <div className="host-header-copy">
                <span className="host-header-kicker">Docentenomgeving</span>
                <strong>{isManagementWorkspace ? activeManagementMeta?.label || "Beheer" : activeWorkspaceMeta.label}</strong>
                <small>{isManagementWorkspace ? "Beheer leerlingen, geschiedenis en accounts." : activeWorkspaceMeta.description}</small>
              </div>
            </div>
            <div className="host-header-status">
              <span className="pill">Sessiecode {hostSession.roomCode || "-----"}</span>
              <span className="pill">{liveStatusText}</span>
              <span className="pill">{onlinePlayerCount} online</span>
              {hostSession.roomCode ? (
                <button
                  className="button-ghost host-qr-trigger"
                  onClick={() => {
                    setJoinQrOpen(true)
                    setHostProfileOpen(false)
                    setHostMenuOpen(false)
                  }}
                  type="button"
                >
                  Toon leerling-QR
                </button>
              ) : null}
              <div className="host-profile-shell">
                <button
                  aria-expanded={hostProfileOpen}
                  className={`button-ghost host-profile-button ${hostProfileOpen ? "is-open" : ""}`}
                  onClick={() => setHostProfileOpen((current) => !current)}
                  type="button"
                >
                  {hostSession.displayName || hostSession.username || "Docent"}
                </button>
                {hostProfileOpen ? (
                  <div className="host-profile-menu">
                    <button className="host-profile-action" onClick={togglePresenterMode} type="button">
                      {presenterMode ? presenterFullscreen ? "Sluit digibordmodus" : "Sluit presentatie" : "Open digibordmodus"}
                    </button>
                    <button
                      className="host-profile-action"
                      onClick={() => {
                        socket.emit("host:room:refresh")
                        setHostProfileOpen(false)
                      }}
                      type="button"
                    >
                      Vernieuw sessiecode
                    </button>
                    <button className="host-profile-action subtle-danger" onClick={logout} type="button">
                      Uitloggen
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </header>

          <div className={`host-menu-overlay ${hostMenuOpen ? "is-visible" : ""}`} onClick={() => setHostMenuOpen(false)} />
          <aside className={`glass host-drawer ${hostMenuOpen ? "is-open" : ""}`}>
            <div className="host-drawer-head">
              <div>
                <span className="host-header-kicker">Werkruimtes</span>
                <h2>{hostSession.displayName || hostSession.username || "Docent"}</h2>
              </div>
              <button className="button-ghost host-drawer-close" onClick={() => setHostMenuOpen(false)} type="button">
                Sluit
              </button>
            </div>
            <div className="host-drawer-group">
              {primaryWorkspaceOptions.map((option) => (
                <button
                  key={option.id}
                  className={`host-drawer-link ${hostWorkspace === option.id ? "is-active" : ""}`}
                  onClick={() => openHostWorkspace(option.id)}
                  type="button"
                >
                  <strong>{option.label}</strong>
                  <span>{option.description}</span>
                </button>
              ))}
            </div>
            <div className="host-drawer-divider" />
            <div className="host-drawer-group">
              <button
                className={`host-drawer-link ${hostWorkspace === "management" ? "is-active" : ""}`}
                onClick={() => openHostWorkspace("management")}
                type="button"
              >
                <strong>Beheer</strong>
                <span>Leerlingen, bibliotheek, geschiedenis en docentaccounts.</span>
              </button>
              {hostWorkspace === "management" ? (
                <div className="management-switch-row host-drawer-management">
                  {visibleManagementOptions.map((option) => (
                    <button
                      key={option.id}
                      className={`management-chip ${managementPanel === option.id ? "is-active" : ""}`}
                      onClick={() => {
                        setManagementPanel(option.id)
                        setHostMenuOpen(false)
                      }}
                      type="button"
                    >
                      <strong>{option.label}</strong>
                      <span>{option.description}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="host-drawer-footer">
              <span className="pill">Sessiecode {hostSession.roomCode || "-----"}</span>
              <button className="button-secondary" onClick={() => socket.emit("host:room:refresh")} type="button">
                Nieuwe code
              </button>
            </div>
          </aside>
        </>
      ) : null}

      {hostSession.authenticated && isHomeWorkspace ? (
        <HostStartPanel
          game={game}
          hostSession={hostSession}
          liveWorkspaceId={liveWorkspaceId}
          liveWorkspaceLabel={liveWorkspaceLabel}
          liveStatusText={liveStatusText}
          liveGroupModeEnabled={liveGroupModeEnabled}
          localBackup={localRoomBackup}
          onMailClick={openSupportMail}
          onOpenWorkspace={openHostWorkspace}
          onRestoreLocalBackup={restoreLocalRoomBackup}
          onlinePlayerCount={onlinePlayerCount}
          recentEntries={recentSessionEntries}
          roomCode={hostSession.roomCode}
          teamCount={teams.length}
        />
      ) : null}

      {hostSession.authenticated && !isManagementWorkspace && !isHomeWorkspace ? (
        <>
      <section className="host-grid">
        <div className="glass control-card teacher-panel teacher-prep-card">
          <div className="section-head">
            <div className="host-panel-heading">
              <span className="host-panel-kicker">Voorbereiden</span>
              <h2>{activeWorkspaceMeta.label}</h2>
            </div>
            <span className="pill">Werkruimte</span>
          </div>
          <div className="host-status-banner">
            <span>Status</span>
            <strong>{status}</strong>
          </div>

          <div className="workspace-callout">
            <strong>{activeWorkspaceMeta.label}</strong>
            <p>{activeWorkspaceMeta.description}</p>
          </div>

          {controlMode === "math" ? (
            <MathBandSelector selectedBand={mathBand} onChange={setMathBand} />
          ) : (
            <label className="field">
              <span>Onderwerp</span>
              <textarea
                rows="4"
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                placeholder={
                  controlMode === "lesson"
                    ? "Bijv. procenten rekenen met korting voor vmbo basis, 45 minuten, veel interactie"
                    : "Bijv. economie vmbo leerjaar 3 over verzekeringen en sparen"
                }
              />
            </label>
          )}

          {controlMode === "math" ? (
            <>
              <div className="field-row">
                <label className="field">
                  <span>Opdrachtnaam</span>
                  <input
                    onChange={(event) => setMathAssignmentTitle(event.target.value)}
                    placeholder="Bijv. Weektaak rekenen verhoudingen"
                    value={mathAssignmentTitle}
                  />
                </label>
                <label className="field">
                  <span>Deadline</span>
                  <input
                    type="datetime-local"
                    onChange={(event) => setMathAssignmentDueAt(event.target.value)}
                    value={mathAssignmentDueAt}
                  />
                </label>
                <label className="field">
                  <span>Klas</span>
                  <select value={selectedMathClassId} onChange={(event) => setSelectedMathClassId(event.target.value)}>
                    <option value="">Geen vaste klas</option>
                    {classrooms.map((classroom) => (
                      <option key={classroom.id} value={classroom.id}>
                        {classroom.name} ({classroom.learnerCount} leerlingen)
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Doel sommen na intake</span>
                  <input
                    type="number"
                    min="4"
                    max="50"
                    onChange={(event) => setMathTargetPracticeCount(Number(event.target.value))}
                    value={mathTargetPracticeCount}
                  />
                </label>
              </div>
              <div className="field math-config-card">
                <span>Rekenroute</span>
                <p>
                  Leerlingen krijgen eerst een instaptoets. Daarna plaatst de site hen op een F-niveau en biedt
                  automatisch sommen aan op het volgende niveau. Hun leercode blijft zichtbaar zodat ze later weer
                  verder kunnen.
                </p>
                {selectedMathClassroom ? (
                  <p>
                    Deze opdracht wordt klaargezet voor <strong>{selectedMathClassroom.name}</strong> met {selectedMathClassroom.learnerCount} leerlingen.
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <div className="teacher-advanced-toggle">
              <button className="button-ghost" onClick={() => setShowAdvancedOptions((current) => !current)} type="button">
                {showAdvancedOptions ? "Minder opties" : "Meer opties"}
              </button>
            </div>
          )}

          {controlMode !== "math" && showAdvancedOptions ? (
            <div className="teacher-advanced-panel">
              <div className="field-row">
                <label className="field">
                  <span>Doelgroep</span>
                  <select value={audience} onChange={(event) => setAudience(event.target.value)}>
                    <option value="vmbo">VMBO</option>
                    <option value="brugklas">Brugklas</option>
                    <option value="mavo/havo">Mavo/Havo</option>
                    <option value="mbo">MBO</option>
                    <option value="algemeen">Algemeen</option>
                  </select>
                </label>

                {controlMode === "lesson" ? (
                  selectedSuiteMode === "lesson" ? (
                    <>
                      <label className="field">
                        <span>Lesmodus</span>
                        <select value={lessonModel} onChange={(event) => setLessonModel(event.target.value)}>
                          <option value="edi">EDI (Directe instructie)</option>
                          <option value="formatief handelen">Formatief handelen</option>
                          <option value="activerende didactiek">Activerende didactiek</option>
                          <option value="directe instructie">Directe instructie</option>
                        </select>
                      </label>
                      <label className="field">
                        <span>Lesduur (min)</span>
                        <input
                          type="number"
                          min="20"
                          max="90"
                          value={lessonDurationMinutes}
                          onChange={(event) => setLessonDurationMinutes(Number(event.target.value))}
                        />
                      </label>
                    </>
                  ) : selectedSuiteMode === "presentation" ? (
                    <>
                      <label className="field">
                        <span>Aantal dia's</span>
                        <input
                          type="number"
                          min="4"
                          max="7"
                          value={presentationSlideCount}
                          onChange={(event) => setPresentationSlideCount(Number(event.target.value))}
                        />
                      </label>
                      <label className="field">
                        <span>Video-opzet</span>
                        <select
                          value={includeVideoPlan ? "ja" : "nee"}
                          onChange={(event) => setIncludeVideoPlan(event.target.value === "ja")}
                        >
                          <option value="nee">Nee</option>
                          <option value="ja">Ja</option>
                        </select>
                      </label>
                    </>
                  ) : (
                    <>
                      <label className="field">
                        <span>Aantal vragen</span>
                        <input
                          type="number"
                          min="6"
                          max="24"
                          value={practiceQuestionCount}
                          onChange={(event) => setPracticeQuestionCount(Number(event.target.value))}
                        />
                      </label>
                      <label className="field">
                        <span>Vorm</span>
                        <select value={practiceQuestionFormat} onChange={(event) => setPracticeQuestionFormat(event.target.value)}>
                          {PRACTICE_QUESTION_FORMAT_OPTIONS.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )
                ) : (
                  <>
                    <label className="field">
                      <span>Aantal vragen</span>
                      <input
                        type="number"
                        min="6"
                        max="24"
                        value={questionCount}
                        onChange={(event) => setQuestionCount(Number(event.target.value))}
                      />
                    </label>
                    <label className="field">
                      <span>Tijd per vraag (sec)</span>
                      <input
                        type="number"
                        min="8"
                        max="60"
                        value={questionDurationSec}
                        onChange={(event) => setQuestionDurationSec(Number(event.target.value))}
                      />
                    </label>
                  </>
                )}
              </div>

              <div className="toggle-grid">
                <button
                  className={`toggle-card ${!groupModeEnabledDraft ? "is-active" : ""}`}
                  onClick={() => setGroupModeEnabledDraft(false)}
                  type="button"
                >
                  <span>Instelling</span>
                  <strong>Individueel werken</strong>
                  <p>Leerlingen vullen alleen hun naam en sessiecode in. Er worden geen groepen gebruikt.</p>
                </button>
                <button
                  className={`toggle-card ${groupModeEnabledDraft ? "is-active" : ""}`}
                  onClick={() => setGroupModeEnabledDraft(true)}
                  type="button"
                >
                  <span>Instelling</span>
                  <strong>Groepsopdracht aan</strong>
                  <p>Leerlingen kunnen een groep kiezen. Wie zonder groep meedoet, blijft individueel zichtbaar.</p>
                </button>
              </div>

              {groupModeEnabledDraft ? (
                <label className="field">
                  <span>Groepen</span>
                  <textarea
                    rows="4"
                    value={teamNamesInput}
                    onChange={(event) => {
                      setIsEditingTeams(true)
                      setTeamNamesInput(event.target.value)
                    }}
                    placeholder="Eén groep per regel"
                  />
                </label>
              ) : (
                <div className="field math-config-card">
                  <span>Groepen uit</span>
                  <p>Deze sessie werkt individueel. Zet groepsopdracht aan als je leerlingen aan groepen wilt koppelen.</p>
                </div>
              )}
            </div>
          ) : null}

          {controlMode === "lesson" ? (
            <LessonSummaryCard
              lesson={game.lesson}
              onSave={game.lesson?.phases?.length ? saveCurrentLesson : null}
              onStartPractice={game.lesson?.practiceTest?.questionCount ? startPracticeTest : null}
            />
          ) : null}

          {game.mode === "math" && controlMode !== "math" ? (
            <div className="field math-config-card">
              <span>Live route blijft actief</span>
              <p>Leerlingen werken nu nog in rekenen. Je kunt hier alvast een les, presentatie of oefentoets voorbereiden. Pas als je op opbouwen/starten klikt, vervang je de live route.</p>
            </div>
          ) : null}

          <div className="action-row">
            {controlMode !== "math" ? (
              <button
                className="button-secondary"
                disabled={!hostSession.authenticated}
                onClick={configureTeams}
                type="button"
              >
                Groepsinstellingen opslaan
              </button>
            ) : null}
            <button
              className="button-primary"
              disabled={!hostSession.authenticated}
              onClick={controlMode === "math" ? generateMathSession : controlMode === "lesson" ? generateLesson : generate}
              type="button"
            >
              {controlMode === "lesson" || controlMode === "math" ? buildActionLabel : "Ronde starten"}
            </button>
            {game.mode === "battle" && game.source !== "practice" && game.question && game.status === "preview" ? (
              <button
                className="button-primary"
                disabled={!hostSession.authenticated}
                onClick={startBattleQuestion}
                type="button"
              >
                Start vraag
              </button>
            ) : null}
            {game.mode === "battle" && game.source !== "practice" && game.question && game.status === "live" ? (
              <button
                className="button-secondary"
                disabled={!hostSession.authenticated || !canRevealBattleAnswer}
                onClick={showBattleAnswer}
                type="button"
              >
                Toon antwoord
              </button>
            ) : null}
            {game.mode === "lesson" ? (
              <button
                className="button-ghost"
                disabled={!hostSession.authenticated || !canGoToPreviousLessonStep}
                onClick={goToPreviousStep}
                type="button"
              >
                Vorige lesstap
              </button>
            ) : null}
            {game.mode !== "math" ? (
              <button
                className="button-secondary"
                disabled={!hostSession.authenticated}
                onClick={goToNextStep}
                type="button"
              >
                {game.mode === "lesson"
                  ? hostInsights?.canAdvance
                    ? "Volgende lesstap (iedereen klaar)"
                    : "Volgende lesstap"
                  : hostInsights?.canAdvance
                    ? "Volgende vraag (iedereen klaar)"
                    : "Volgende vraag"}
              </button>
            ) : null}
            <button
              className="button-ghost"
              disabled={!hostSession.authenticated}
              onClick={() => socket.emit("host:reset")}
              type="button"
            >
              Nieuwe ronde
            </button>
          </div>
        </div>

        <div className="glass question-stage teacher-panel teacher-live-card">
          <div className="section-head">
            <div className="host-panel-heading">
              <span className="host-panel-kicker">Live in de klas</span>
              <h2>{game.mode === "lesson" ? "Live les" : game.mode === "math" ? "Live rekenen" : "Live vraag"}</h2>
            </div>
            <div className="pill-row">
              <span className="pill timer-pill">
                {game.mode === "lesson"
                  ? game.lesson?.currentPhase
                    ? `${game.lesson.currentPhase.minutes} min`
                    : "Les"
                  : game.mode === "math"
                    ? game.math?.selectedBand
                      ? `Route ${formatMathLevelLabel(game.math.selectedBand)}`
                      : "Rekenen"
                  : game.status === "preview"
                    ? "Preview"
                  : game.status === "live"
                    ? `${timeLeft}s`
                    : game.status === "revealed"
                      ? "Antwoord"
                      : "Klaar"}
              </span>
              <span className="pill">
                {game.mode === "lesson"
                  ? game.status === "live"
                    ? `Fase ${game.currentPhaseIndex + 1} / ${game.totalPhases}`
                    : game.status === "finished"
                      ? "Les afgerond"
                      : "Nog niet gestart"
                  : game.mode === "math"
                    ? `${players.length} leerlingen in route`
                  : game.status === "preview"
                    ? `Preview ${game.currentQuestionIndex + 1} / ${game.totalQuestions}`
                  : game.status === "live"
                    ? `Vraag ${game.currentQuestionIndex + 1} / ${game.totalQuestions}`
                    : game.status === "revealed"
                      ? `Antwoord ${game.currentQuestionIndex + 1} / ${game.totalQuestions}`
                    : game.status === "finished"
                      ? "Ronde klaar"
                      : "Nog niet gestart"}
              </span>
            </div>
          </div>

          {game.mode === "lesson" ? (
            <LessonProgress lesson={game.lesson} />
          ) : game.mode === "math" ? (
            <MathHostSummary math={game.math} players={players} />
          ) : (
            <ProgressBar
              current={game.currentQuestionIndex + 1}
              total={game.totalQuestions}
              timeLeft={timeLeft}
              duration={game.questionDurationSec}
            />
          )}

          {game.mode === "math" && game.math ? (
            <MathHostPanel
              onExportCsv={exportLearnersCsv}
              learnerCodeDrafts={learnerCodeDrafts}
              localBackup={localRoomBackup}
              math={game.math}
              newMathLearner={newMathLearner}
              onClearLocalBackup={clearLocalRoomBackupFromDevice}
              onCreateLearner={createMathLearner}
              onLearnerCodeChange={(playerId, value) =>
                setLearnerCodeDrafts((current) => ({ ...current, [playerId]: value }))
              }
              onNewLearnerChange={setNewMathLearner}
              onLearnerCodeSave={updateLearnerCode}
              onRestoreLocalBackup={restoreLocalRoomBackup}
              insights={hostInsights}
            />
          ) : game.mode === "lesson" && game.lesson?.currentPhase ? (
            <>
              <LessonStageCard lesson={game.lesson} hostView />
              <LessonPresentationPanel
                interactive={Boolean(game.lesson?.presentation?.currentSlide)}
                onOpen={openPresenterMode}
                presentation={game.lesson?.presentation}
              />
              <ManualSlideImageCard
                altText={manualSlideImageAltDraft}
                hasManualImage={Boolean(currentPresentationSlide?.manualImageUrl)}
                imageUrl={manualSlideImageUrlDraft}
                onAutoSearch={autoFindSlideImage}
                onAltTextChange={setManualSlideImageAltDraft}
                onClear={clearManualSlideImage}
                onImageUrlChange={setManualSlideImageUrlDraft}
                onSaveUrl={saveManualSlideImageUrl}
                onUpload={uploadManualSlideImage}
                isBusy={slideImageBusy}
                slide={currentPresentationSlide}
                uploadName={manualSlideUploadName}
              />
              <LessonPromptComposer
                expectedAnswer={lessonExpectedAnswerDraft}
                onExpectedAnswerChange={setLessonExpectedAnswerDraft}
                onSubmit={updateLessonPrompt}
                onTextChange={setLessonPromptDraft}
                text={lessonPromptDraft}
              />
              <HostInsightsCard insights={hostInsights} />
            </>
          ) : game.mode === "lesson" && game.status === "finished" ? (
            <LessonCompleteCard lesson={game.lesson} />
          ) : game.question ? (
            <>
              {game.mode === "battle" && liveGroupModeEnabled ? <BattleRaceBanner game={game} teams={teams} variant="compact" /> : null}
              <QuestionCard question={game.question} />
              {game.mode === "battle" && game.source !== "practice" ? (
                <BattleQuestionControls
                  answerWindowExpired={Boolean(battleAnswerWindowExpired)}
                  answeredCount={hostInsights?.answeredCount || 0}
                  canReveal={canRevealBattleAnswer}
                  duration={battleDurationDraft}
                  finalSprintActive={game.finalSprintActive}
                  onDurationChange={setBattleDurationDraft}
                  onReveal={showBattleAnswer}
                  onStart={startBattleQuestion}
                  questionMultiplier={game.questionMultiplier}
                  status={game.status}
                  totalPlayers={hostInsights?.totalPlayers || 0}
                />
              ) : null}
              {battleRevealHelperText ? <p className="battle-waiting-hint">{battleRevealHelperText}</p> : null}
              <HostInsightsCard insights={hostInsights} />
            </>
          ) : game.status === "finished" ? (
            <ResultsCard teams={teams} leaderboard={leaderboard} showGroups={liveGroupModeEnabled} />
          ) : (
            <LobbyCard
              groupModeEnabled={liveGroupModeEnabled}
              joinQrUrl={classroomJoinQrUrl}
              joinUrl={classroomJoinUrl}
              onOpenQr={() => setJoinQrOpen(true)}
              roomCode={hostSession.roomCode}
              teams={teams}
              players={players}
              onlineCount={onlinePlayerCount}
            />
          )}
        </div>
      </section>

      <section className="dashboard-grid">
        <ScoreBoard teams={teams} leaderboard={leaderboard} showGroups={liveGroupModeEnabled} />
        <RosterBoard
          groupModeEnabled={liveGroupModeEnabled}
          onlineCount={onlinePlayerCount}
          onRemovePlayer={(playerId) => socket.emit("host:remove-player", { playerId })}
          players={players}
          teams={teams}
        />
      </section>
        </>
      ) : hostSession.authenticated && isManagementWorkspace ? (
        <section className="management-workspace">
          <section className="glass board-card management-header-card teacher-panel">
            <div className="section-head">
              <div className="host-panel-heading">
                <span className="host-panel-kicker">Beheer</span>
                <h2>Beheer</h2>
              </div>
              <span className="pill">{activeManagementMeta?.label || "Beheer"}</span>
            </div>
            <p className="muted">
              Hier beheer je leerlingen, opgeslagen lessen, geschiedenis en docentaccounts zonder dat de rest van je scherm volloopt.
            </p>
          </section>

          {managementPanel === "learners" ? (
            <>
              {game.mode === "math" && game.math ? (
                <MathHostPanel
                  onExportCsv={exportLearnersCsv}
                  learnerCodeDrafts={learnerCodeDrafts}
                  localBackup={localRoomBackup}
                  math={game.math}
                  newMathLearner={newMathLearner}
                  onClearLocalBackup={clearLocalRoomBackupFromDevice}
                  onCreateLearner={createMathLearner}
                  onLearnerCodeChange={(playerId, value) =>
                    setLearnerCodeDrafts((current) => ({ ...current, [playerId]: value }))
                  }
                  onNewLearnerChange={setNewMathLearner}
                  onLearnerCodeSave={updateLearnerCode}
                  onRestoreLocalBackup={restoreLocalRoomBackup}
                  insights={hostInsights}
                />
              ) : null}
              {game.mode !== "math" ? (
                <div className="management-toolbar-actions management-inline-actions">
                  <button className="button-ghost" onClick={exportLearnersCsv} type="button">
                    Exporteer leerlingen CSV
                  </button>
                </div>
              ) : null}
              <section className="dashboard-grid management-dashboard-grid">
                <ScoreBoard teams={teams} leaderboard={leaderboard} showGroups={liveGroupModeEnabled} />
                <RosterBoard
                  groupModeEnabled={liveGroupModeEnabled}
                  onlineCount={onlinePlayerCount}
                  onRemovePlayer={(playerId) => socket.emit("host:remove-player", { playerId })}
                  players={players}
                  teams={teams}
                />
              </section>
            </>
          ) : null}

          {managementPanel === "classes" ? (
            <ClassesSection
              audienceFilter={classroomAudienceFilter}
              classroomImportBusyId={classroomImportBusyId}
              classroomDrafts={classroomDrafts}
              classroomLearnerDrafts={classroomLearnerDrafts}
              classroomLearnerEditDrafts={classroomLearnerEditDrafts}
              classrooms={filteredClassrooms}
              availableAudiences={classroomAudiences}
              newClassroomForm={newClassroomForm}
              onAudienceFilterChange={setClassroomAudienceFilter}
              onClassroomDelete={deleteClassroom}
              onClassroomDraftChange={(classId, updater) =>
                setClassroomDrafts((current) => ({
                  ...current,
                  [classId]:
                    typeof updater === "function"
                      ? updater(current[classId] || { name: "", sectionName: "", audience: "vmbo" })
                      : updater,
                }))
              }
              onClassroomLearnerAdd={addLearnerToClassroom}
              onClassroomLearnerDelete={deleteClassroomLearner}
              onClassroomLearnerDraftChange={(classId, updater) =>
                setClassroomLearnerDrafts((current) => ({
                  ...current,
                  [classId]:
                    typeof updater === "function"
                      ? updater(current[classId] || { name: "", learnerCode: "", studentNumber: "" })
                      : updater,
                }))
              }
              onClassroomLearnerEditChange={(learnerId, updater) =>
                setClassroomLearnerEditDrafts((current) => ({
                  ...current,
                  [learnerId]:
                    typeof updater === "function"
                      ? updater(current[learnerId] || { name: "", learnerCode: "", studentNumber: "" })
                      : updater,
                }))
              }
              onClassroomImport={importLearnersIntoClassroom}
              onClassroomLearnerSave={saveClassroomLearner}
              onClassroomSave={updateClassroom}
              onCreateClassroom={createClassroom}
              onNewClassroomChange={setNewClassroomForm}
              onExportCsv={exportClassroomsCsv}
              onSearchChange={setClassroomSearch}
              onSelectForMath={(classId) => {
                setSelectedMathClassId(classId)
                setStatus(`Klas ${classrooms.find((entry) => entry.id === classId)?.name || ""} staat klaar voor de volgende rekenroute.`)
              }}
              searchValue={classroomSearch}
              selectedMathClassId={selectedMathClassId}
              totalCount={classrooms.length}
            />
          ) : null}

          {managementPanel === "library" ? (
            <LessonLibrarySection
              activeLessonId={game.lesson?.libraryId || null}
              audienceFilter={libraryAudienceFilter}
              availableAudiences={lessonLibraryAudiences}
              availableFolders={lessonLibraryFolders}
              availableSections={lessonLibrarySections}
              folderFilter={libraryFolderFilter}
              metaDrafts={libraryMetaDrafts}
              lessons={filteredLessonLibrary}
              onDelete={deleteLessonFromLibrary}
              onExportCsv={exportLessonLibraryCsv}
              onFavoriteToggle={toggleLessonFavorite}
              onFolderFilterChange={setLibraryFolderFilter}
              onLoad={loadLessonFromLibrary}
              onMetaDraftChange={(lessonId, updater) =>
                setLibraryMetaDrafts((current) => ({
                  ...current,
                  [lessonId]:
                    typeof updater === "function"
                      ? updater(current[lessonId] || { folderName: "", sectionName: "", tags: "" })
                      : updater,
                }))
              }
              onMetaSave={updateLessonLibraryMeta}
              onAudienceFilterChange={setLibraryAudienceFilter}
              onSectionFilterChange={setLibrarySectionFilter}
              onSearchChange={setLibrarySearch}
              sectionFilter={librarySectionFilter}
              searchValue={librarySearch}
              totalCount={lessonLibrary.length}
            />
          ) : null}

          {managementPanel === "history" ? (
            <SessionHistorySection
              categoryFilter={historyCategoryFilter}
              entries={filteredSessionHistory}
              historyCategories={historyCategories}
              onDelete={deleteSessionFromHistory}
              onExportCsv={exportSessionHistoryCsv}
              onLoad={loadSessionFromHistory}
              onCategoryFilterChange={setHistoryCategoryFilter}
              onSearchChange={setHistorySearch}
              onTypeFilterChange={setHistoryTypeFilter}
              searchValue={historySearch}
              totalCount={sessionHistory.length}
              typeFilter={historyTypeFilter}
            />
          ) : null}

          {managementPanel === "accounts" && hostSession.canManageAccounts ? (
            <TeacherAccountsSection
              accounts={teacherAccounts}
              canAssignManagerRole={hostSession.role === "owner"}
              form={teacherAccountForm}
              onCreate={createTeacherAccount}
              onDelete={deleteTeacherAccount}
              onDraftPasswordChange={(accountId, value) =>
                setTeacherPasswordDrafts((current) => ({ ...current, [accountId]: value }))
              }
              onFormChange={setTeacherAccountForm}
              onUpdate={updateTeacherAccount}
              passwordDrafts={teacherPasswordDrafts}
            />
          ) : null}
        </section>
      ) : null}

      {presenterMode && game.mode === "lesson" && game.lesson?.presentation?.currentSlide ? (
        <LessonPresenterOverlay
          insights={hostInsights}
          lesson={game.lesson}
          onClose={closePresenterMode}
          onPrevious={goToPreviousStep}
          onNext={goToNextStep}
        />
      ) : null}

      {presenterMode && game.mode === "battle" && game.question ? (
        <BattlePresenterOverlay
          canReveal={canRevealBattleAnswer}
          game={game}
          insights={hostInsights}
          onClose={closePresenterMode}
          onNext={goToNextStep}
          onReveal={showBattleAnswer}
          onStart={startBattleQuestion}
          timeLeft={timeLeft}
        />
      ) : null}

      {joinQrOpen && hostSession.roomCode ? (
        <SessionQrOverlay
          joinUrl={classroomJoinUrl}
          qrCodeUrl={classroomJoinQrLargeUrl}
          roomCode={hostSession.roomCode}
          onClose={() => setJoinQrOpen(false)}
        />
      ) : null}
    </main>
  )
}

function PlayerPage() {
  const { players, teams, leaderboard, game } = useQuizState()
  const joinSessionCodeFromUrl = useMemo(() => readJoinSessionCodeFromUrl(), [])
  const [playerSession, setPlayerSession] = useState(() => {
    try {
      const stored = window.localStorage.getItem(PLAYER_SESSION_KEY)
      return stored
        ? JSON.parse(stored)
        : {
            name: "",
            teamId: "",
            roomCode: "",
            joined: false,
            playerId: "",
            playerSessionId: createPlayerSessionId(),
            learnerCode: "",
            joinMode: PLAYER_JOIN_MODE_CLASSROOM,
          }
    } catch {
      return {
        name: "",
        teamId: "",
        roomCode: "",
        joined: false,
        playerId: "",
        playerSessionId: createPlayerSessionId(),
        learnerCode: "",
        joinMode: PLAYER_JOIN_MODE_CLASSROOM,
      }
    }
  })
  const storedJoinMode = joinSessionCodeFromUrl ? PLAYER_JOIN_MODE_CLASSROOM : playerSession.joinMode || PLAYER_JOIN_MODE_CLASSROOM
  const [name, setName] = useState(playerSession.name || "")
  const [teamId, setTeamId] = useState(playerSession.teamId || "")
  const [roomCode, setRoomCode] = useState(joinSessionCodeFromUrl || playerSession.roomCode || "")
  const [playerId, setPlayerId] = useState(playerSession.playerId || "")
  const [playerSessionId, setPlayerSessionId] = useState(playerSession.playerSessionId || createPlayerSessionId())
  const [learnerCode, setLearnerCode] = useState(playerSession.learnerCode || "")
  const [joinMode, setJoinMode] = useState(storedJoinMode)
  const [joinCodeLockedFromUrl, setJoinCodeLockedFromUrl] = useState(Boolean(joinSessionCodeFromUrl))
  const [roomPreview, setRoomPreview] = useState({ valid: false, teams: [], intakeTotal: 0, mode: "battle", groupModeEnabled: false })
  const [joined, setJoined] = useState(
    Boolean(joinSessionCodeFromUrl ? false : storedJoinMode === PLAYER_JOIN_MODE_HOME_MATH ? false : playerSession.joined)
  )
  const [homeMathSession, setHomeMathSession] = useState(null)
  const [learnerPortal, setLearnerPortal] = useState(null)
  const [selfPracticeSession, setSelfPracticeSession] = useState(null)
  const [selfPracticeTopic, setSelfPracticeTopic] = useState("")
  const [selfPracticeQuestionCount, setSelfPracticeQuestionCount] = useState(8)
  const [selfPracticeQuestionFormat, setSelfPracticeQuestionFormat] = useState("multiple-choice")
  const [result, setResult] = useState(null)
  const [chosenAnswer, setChosenAnswer] = useState(null)
  const [answerLocked, setAnswerLocked] = useState(false)
  const [practiceTextAnswer, setPracticeTextAnswer] = useState("")
  const [mathAnswer, setMathAnswer] = useState("")
  const [lessonAnswer, setLessonAnswer] = useState("")
  const [lessonResult, setLessonResult] = useState(null)
  const [status, setStatus] = useState("Vul je gegevens in en sluit aan.")
  const nameInputRef = useRef(null)
  const timeLeft = useQuestionCountdown(game)
  const liveResult = game.mode === "math" ? game.math?.lastResult || null : result
  const isLocalHomeMath = Boolean(homeMathSession)
  const isSelfPracticeActive = Boolean(selfPracticeSession)
  const isLiveMathRoute = Boolean(joined && game.mode === "math" && game.math)
  const resetLearnerLiveState = () => {
    setJoined(false)
    setPlayerId("")
    setResult(null)
    setChosenAnswer(null)
    setAnswerLocked(false)
    setPracticeTextAnswer("")
    setMathAnswer("")
    setLessonAnswer("")
    setLessonResult(null)
  }

  useSoundEffects(liveResult, game.status)

  useEffect(() => {
    const sourceTeams = joined ? teams : roomPreview.valid ? roomPreview.teams : teams
    const groupsAllowed =
      (joined ? Boolean(game.groupModeEnabled) : Boolean(roomPreview.groupModeEnabled)) &&
      (joined ? game.mode !== "math" : roomPreview.mode !== "math")

    if (!groupsAllowed) {
      if (teamId) setTeamId("")
      return
    }

    if (!sourceTeams.length) {
      if (teamId) setTeamId("")
      return
    }

    if (teamId && !sourceTeams.some((team) => team.id === teamId)) {
      setTeamId("")
    }
  }, [game.groupModeEnabled, game.mode, joined, roomPreview, teamId, teams])

  useEffect(() => {
    if (!joinSessionCodeFromUrl) return
    setJoinMode(PLAYER_JOIN_MODE_CLASSROOM)
    setJoinCodeLockedFromUrl(true)
    setRoomCode(joinSessionCodeFromUrl)
    resetLearnerLiveState()
    setTeamId("")
    setHomeMathSession(null)
    setResult(null)
    setChosenAnswer(null)
    setAnswerLocked(false)
    setStatus("Sessiecode is al ingevuld via de QR-code. Vul alleen je naam in.")
    window.requestAnimationFrame(() => nameInputRef.current?.focus())
  }, [joinSessionCodeFromUrl])

  useEffect(() => {
    const onJoined = (nextMode = roomPreview.mode) => {
      setLearnerPortal((current) =>
        current || (name.trim() && /^\d{4}$/.test(learnerCode) ? { name: name.trim(), learnerCode, audience: "vmbo" } : current)
      )
      setHomeMathSession(null)
      setSelfPracticeSession(null)
      setJoined(true)
      setStatus(nextMode === "math" ? "Je bent verbonden. Je rekensom of instaptoets staat voor je klaar." : "Je bent verbonden. Wacht op de volgende vraag.")
    }
    const onJoinedPayload = ({ playerId: nextPlayerId, playerSessionId: nextPlayerSessionId, learnerCode: nextLearnerCode, roomCode: nextRoomCode, mode: nextMode }) => {
      if (nextPlayerId) setPlayerId(nextPlayerId)
      if (nextPlayerSessionId) setPlayerSessionId(nextPlayerSessionId)
      if (nextLearnerCode) setLearnerCode(nextLearnerCode)
      if (nextRoomCode) setRoomCode(nextRoomCode)
      onJoined(nextMode || roomPreview.mode)
    }
    const onPlayerError = ({ message }) => {
      const text = String(message || "")
      if (joinMode === PLAYER_JOIN_MODE_HOME_MATH && /geen actieve rekenroute/i.test(text)) {
        const localSnapshot = readHomeMathSnapshot(name.trim(), learnerCode)
        const localMath = activateHomeMathSnapshot(localSnapshot)
        if (localMath) {
          setHomeMathSession(localMath)
          if (localSnapshot?.roomCode) setRoomCode(localSnapshot.roomCode)
          setJoined(true)
          setStatus("Je gaat verder met je opgeslagen oefenroute op dit apparaat.")
          return
        }
        resetLearnerLiveState()
        setStatus("Je bent ingelogd. Er staat nu geen actieve rekenroute klaar, maar je kunt hieronder wel zelf een oefentoets starten.")
        return
      }
      setStatus(text)
    }
    const onRoomPreview = (payload) => {
      setRoomPreview(payload)
      if (joinMode !== PLAYER_JOIN_MODE_CLASSROOM) return
      if (payload.valid) {
        setStatus(
          payload.mode === "math"
            ? `Rekenroom ${payload.roomCode} gevonden. De instaptoets heeft ${payload.intakeTotal || 0} vragen.`
            : `Room ${payload.roomCode} gevonden.`
        )
      } else if (roomCode.length >= 5) {
        setStatus("Deze sessiecode bestaat niet.")
      }
    }
    const onRemoved = ({ message }) => {
      setHomeMathSession(null)
      setJoined(false)
      setResult(null)
      setChosenAnswer(null)
      setAnswerLocked(false)
      setStatus(message || "Je bent verwijderd door de beheerder.")
    }
    const onAnswerResult = (payload) => {
      if (Number.isInteger(payload?.answerIndex)) {
        setChosenAnswer(payload.answerIndex)
      }
      if (typeof payload?.answerText === "string") {
        setPracticeTextAnswer(payload.answerText)
      }
      setResult(payload)
      setAnswerLocked(true)
      setStatus(buildAnswerStatusText(payload))
    }
    const onLessonResponseResult = (payload) => {
      setLessonResult(payload)
      setStatus(
        payload.isCorrect
          ? "Je reactie is ontvangen en sluit goed aan."
          : payload.label === "Bijna"
            ? "Je reactie is ontvangen. Vul hem nog iets scherper aan."
            : "Je reactie is ontvangen. Kijk nog eens naar de opdracht."
      )
    }
    const onProfileUpdate = ({ playerId: nextPlayerId, learnerCode: nextLearnerCode }) => {
      if (nextPlayerId) setPlayerId(nextPlayerId)
      if (nextLearnerCode) setLearnerCode(nextLearnerCode)
      setStatus("Je leercode is bijgewerkt. Je voortgang blijft bewaard.")
    }
    const onPortalReady = (payload) => {
      setJoined(false)
      setPlayerId("")
      setLearnerPortal(payload)
      if (joinMode === PLAYER_JOIN_MODE_HOME_MATH && !homeMathSession && !selfPracticeSession) {
        setStatus("Je bent ingelogd. Kies hieronder of je verder rekent of een oefentoets start.")
      }
    }
    const onSelfPracticeStarted = (payload) => {
      setSelfPracticeSession(createSelfPracticeSession(payload))
      setPracticeTextAnswer("")
      setChosenAnswer(null)
      setAnswerLocked(false)
      setResult(null)
      setJoined(false)
      setStatus("Je oefentoets staat klaar. Werk rustig vraag voor vraag.")
    }

    socket.on("player:joined", onJoinedPayload)
    socket.on("player:error", onPlayerError)
    socket.on("player:removed", onRemoved)
    socket.on("player:room:preview", onRoomPreview)
    socket.on("player:answer:result", onAnswerResult)
    socket.on("player:lesson-response:result", onLessonResponseResult)
    socket.on("player:profile:update", onProfileUpdate)
    socket.on("player:portal:ready", onPortalReady)
    socket.on("player:self-practice:started", onSelfPracticeStarted)

    return () => {
      socket.off("player:joined", onJoinedPayload)
      socket.off("player:error", onPlayerError)
      socket.off("player:removed", onRemoved)
      socket.off("player:room:preview", onRoomPreview)
      socket.off("player:answer:result", onAnswerResult)
      socket.off("player:lesson-response:result", onLessonResponseResult)
      socket.off("player:profile:update", onProfileUpdate)
      socket.off("player:portal:ready", onPortalReady)
      socket.off("player:self-practice:started", onSelfPracticeStarted)
    }
  }, [homeMathSession, joinMode, joined, learnerCode, name, roomCode.length, selfPracticeSession])

  useEffect(() => {
    const nextSession = { name, teamId, roomCode, joined, playerId, playerSessionId, learnerCode, joinMode }
    setPlayerSession(nextSession)
    window.localStorage.setItem(PLAYER_SESSION_KEY, JSON.stringify(nextSession))
  }, [joinMode, joined, learnerCode, name, playerId, playerSessionId, roomCode, teamId])

  useEffect(() => {
    if (joinMode !== PLAYER_JOIN_MODE_CLASSROOM) {
      setRoomPreview({ valid: false, teams: [], intakeTotal: 0, mode: "battle", groupModeEnabled: false })
      return
    }

    if (roomCode.trim().length < 5) {
      setRoomPreview({ valid: false, teams: [], intakeTotal: 0, mode: "battle", groupModeEnabled: false })
      return
    }

    socket.emit("player:lookup-room", { roomCode: roomCode.trim().toUpperCase() })
  }, [joinMode, roomCode])

  useEffect(() => {
    const normalizedCode = roomCode.trim().toUpperCase()

    if (joinMode !== PLAYER_JOIN_MODE_CLASSROOM || joined || normalizedCode.length < 5) return undefined

    const intervalId = window.setInterval(() => {
      socket.emit("player:lookup-room", { roomCode: normalizedCode })
    }, 2000)

    return () => window.clearInterval(intervalId)
  }, [joinMode, joined, roomCode])

  useEffect(() => {
    setResult(null)
    setChosenAnswer(null)
    setAnswerLocked(false)
    setPracticeTextAnswer("")
    setMathAnswer("")
    setLessonAnswer("")
    setLessonResult(null)
  }, [game.question?.id])

  useEffect(() => {
    setLessonAnswer("")
    setLessonResult(null)
  }, [game.lesson?.currentPhase?.id, game.lesson?.currentPhase?.prompt, game.lesson?.promptVersion])

  useEffect(() => {
    setMathAnswer("")
  }, [game.math?.currentTask?.id, homeMathSession?.currentTask?.id])

  useEffect(() => {
    if (!joined || game.mode !== "math" || !game.math || !name.trim() || !/^\d{4}$/.test(learnerCode)) return
    writeHomeMathSnapshotFromServer({
      name: name.trim(),
      learnerCode,
      roomCode,
      math: game.math,
    })
  }, [game.math, game.mode, joined, learnerCode, name, roomCode])

  useEffect(() => {
    if (!joined || joinMode !== PLAYER_JOIN_MODE_HOME_MATH || homeMathSession || !name.trim() || !/^\d{4}$/.test(learnerCode)) return
    const localSnapshot = readHomeMathSnapshot(name.trim(), learnerCode)
    const localMath = activateHomeMathSnapshot(localSnapshot)
    if (!localMath) return
    setHomeMathSession(localMath)
    if (localSnapshot?.roomCode) setRoomCode(localSnapshot.roomCode)
    setStatus("Je opgeslagen oefenroute is direct geladen.")
  }, [homeMathSession, joinMode, joined, learnerCode, name])

  useEffect(() => {
    if (joinMode !== PLAYER_JOIN_MODE_HOME_MATH) return
    if (isLocalHomeMath || isSelfPracticeActive || isLiveMathRoute) return
    if (!joined && !playerId) return
    resetLearnerLiveState()
  }, [isLiveMathRoute, isLocalHomeMath, isSelfPracticeActive, joinMode, joined, playerId])

  useEffect(() => {
    if (joined) return
    setStatus(
      joinMode === PLAYER_JOIN_MODE_HOME_MATH
        ? "Vul je naam en leerlingcode in. Daarna kun je zelfstandig oefenen of je rekenroute hervatten."
        : joinCodeLockedFromUrl
          ? "Sessiecode is al ingevuld via de QR-code. Vul alleen je naam in."
          : "Vul je gegevens in en sluit aan."
    )
  }, [joinCodeLockedFromUrl, joinMode, joined])

  useEffect(() => {
    const onConnect = () => {
      const normalizedCode = roomCode.trim().toUpperCase()
      if (joinMode === PLAYER_JOIN_MODE_CLASSROOM && normalizedCode.length >= 5) {
        socket.emit("player:lookup-room", { roomCode: normalizedCode })
      }
      const canReconnect =
        joined &&
        ((normalizedCode.length >= 5 &&
          ((roomPreview.mode === "math" && /^\d{4}$/.test(learnerCode)) || Boolean(name.trim()))) ||
          (joinMode === PLAYER_JOIN_MODE_HOME_MATH && Boolean(name.trim()) && /^\d{4}$/.test(learnerCode)))
      if (canReconnect) {
        if (normalizedCode.length >= 5) {
          socket.emit("player:join", {
            name: name.trim(),
            teamId,
            roomCode: normalizedCode,
            playerSessionId,
            learnerCode,
          })
        } else if (joinMode === PLAYER_JOIN_MODE_HOME_MATH) {
          socket.emit("player:resume-math", {
            name: name.trim(),
            learnerCode,
            playerSessionId,
          })
        }
      }
    }

    socket.on("connect", onConnect)
    return () => socket.off("connect", onConnect)
  }, [joinMode, joined, learnerCode, name, playerSessionId, roomCode, roomPreview.mode, teamId])

  const join = () => {
    if (joinMode === PLAYER_JOIN_MODE_HOME_MATH) {
      resetLearnerLiveState()
      setLearnerPortal(null)
      setHomeMathSession(null)
      setSelfPracticeSession(null)
      setStatus("Je leerlinglogin wordt gecontroleerd...")
      socket.emit("player:portal:login", {
        name: name.trim(),
        learnerCode,
      })
      const localSnapshot = readHomeMathSnapshot(name.trim(), learnerCode)
      const localMath = activateHomeMathSnapshot(localSnapshot)
      if (localMath) {
        setHomeMathSession(localMath)
        setJoined(true)
        if (localSnapshot?.roomCode) setRoomCode(localSnapshot.roomCode)
        setStatus("Je oefenroute staat klaar. Je kunt direct verder.")
      }
      socket.emit("player:resume-math", {
        name: name.trim(),
        learnerCode,
        playerSessionId,
      })
      return
    }

    setLearnerPortal(null)
    setSelfPracticeSession(null)
    socket.emit("player:join", {
      name: name.trim(),
      teamId,
      roomCode: roomCode.trim().toUpperCase(),
      playerSessionId,
      learnerCode,
    })
  }

  const submitMathAnswer = () => {
    if (homeMathSession) {
      const nextMath = submitHomeMathAnswer(homeMathSession, mathAnswer)
      setHomeMathSession(nextMath)
      setMathAnswer("")
      setStatus(nextMath?.lastResult?.feedback || "Je antwoord is nagekeken.")
      return
    }
    socket.emit("player:math:answer", { answer: mathAnswer })
  }

  const retryMathIntakeAnswer = () => {
    if (homeMathSession) {
      const nextMath = retryHomeMathIntake(homeMathSession)
      setHomeMathSession(nextMath)
      setMathAnswer("")
      setStatus("Pas je antwoord aan en check opnieuw.")
      return
    }
    setMathAnswer("")
    setStatus("Pas je antwoord aan en check opnieuw.")
    socket.emit("player:math:retry-intake")
  }

  const goToNextMathTask = () => {
    if (homeMathSession) {
      const nextMath = nextHomeMathTask(homeMathSession)
      setHomeMathSession(nextMath)
      setMathAnswer("")
      setStatus(nextMath?.phase === "practice" ? "Nieuwe som klaar. Succes." : "Volgende vraag staat voor je klaar.")
      return
    }
    socket.emit("player:math:next")
  }

  const submitLessonAnswer = () => {
    socket.emit("player:lesson-response", { response: lessonAnswer })
  }

  const startSelfPractice = () => {
    socket.emit("player:self-practice:start", {
      name: name.trim(),
      learnerCode,
      topic: selfPracticeTopic,
      questionCount: selfPracticeQuestionCount,
      questionFormat: selfPracticeQuestionFormat,
    })
    setStatus("Je oefentoets wordt klaargezet...")
  }

  const submitSelfPracticeAnswer = ({ answerIndex = null, answerText = "" } = {}) => {
    if (!selfPracticeSession) return
    const nextSession = submitSelfPracticeSessionAnswer(selfPracticeSession, { answerIndex, answerText })
    setSelfPracticeSession(nextSession)
    setPracticeTextAnswer(String(answerText || "").trim())
    setChosenAnswer(Number.isInteger(answerIndex) ? answerIndex : null)
    setAnswerLocked(true)
    setStatus(nextSession.currentResult?.correct ? "Goed gedaan. Kijk naar de uitleg en ga daarna verder." : "Kijk naar de uitleg en probeer de volgende vraag daarna opnieuw.")
  }

  const goToNextSelfPracticeQuestion = () => {
    if (!selfPracticeSession) return
    const nextSession = advanceSelfPracticeSession(selfPracticeSession)
    setSelfPracticeSession(nextSession)
    setPracticeTextAnswer("")
    setChosenAnswer(null)
    setAnswerLocked(false)
    if (nextSession.finishedAt) {
      setStatus("Je oefentoets is afgerond. Kies gerust een nieuw onderwerp.")
      return
    }
    setStatus("Nieuwe vraag klaar. Werk rustig verder.")
  }

  const availableTeams = joined ? teams : roomPreview.valid ? roomPreview.teams : teams
  const liveGroupModeEnabled = Boolean(game.groupModeEnabled)
  const isMathPreview = roomPreview.mode === "math" || game.mode === "math"
  const isHomeMathJoin = joinMode === PLAYER_JOIN_MODE_HOME_MATH
  const joinGroupModeEnabled =
    !isHomeMathJoin && !isMathPreview && Boolean(joined ? liveGroupModeEnabled : roomPreview.groupModeEnabled)
  const needsRoomCode = !isHomeMathJoin
  const needsLearnerCode = isMathPreview || isHomeMathJoin
  const selectedTeam = availableTeams.find((team) => team.id === teamId)
  const currentPlayer = useMemo(
    () => players.find((player) => player.id === playerId) || leaderboard.find((player) => player.id === playerId) || null,
    [leaderboard, playerId, players]
  )
  const currentTeam =
    liveGroupModeEnabled ? teams.find((team) => team.id === (currentPlayer?.teamId || teamId)) || selectedTeam || null : null
  const currentRank = currentPlayer ? leaderboard.findIndex((player) => player.id === currentPlayer.id) + 1 : 0
  const isMathLive = game.mode === "math" && Boolean(game.math)
  const isPracticeTestLive = game.source === "practice"
  const isLastPracticeQuestion = isPracticeTestLive && game.currentQuestionIndex + 1 >= game.totalQuestions
  const canAdvancePracticeQuestion =
    joined &&
    isPracticeTestLive &&
    game.question &&
    (Boolean(result) || timeLeft === 0)
  const hasLessonPresentation = Boolean(game.lesson?.presentation?.currentSlide || game.lesson?.presentation?.slideCount)
  const hasLessonPrompt = Boolean(game.lesson?.currentPhase?.hasPrompt && game.lesson?.currentPhase?.prompt?.trim())
  const battleRevealVisible =
    game.mode === "battle" &&
    game.source !== "practice" &&
    game.status === "revealed" &&
    game.question &&
    typeof game.question.correctIndex === "number"
  const isTypedPracticeQuestion = isPracticeTestLive && game.question?.questionType === "typed"
  const canAnswerLiveQuestion =
    joined &&
    game.mode === "battle" &&
    game.status === "live" &&
    game.question &&
    !battleRevealVisible &&
    !result
  const canSubmitQuestion = joined && game.question && (canAnswerLiveQuestion || isPracticeTestLive) && !answerLocked
  const canSubmitChoiceAnswer = canSubmitQuestion && !isTypedPracticeQuestion
  const canSubmitTypedAnswer = canSubmitQuestion && isTypedPracticeQuestion && Boolean(practiceTextAnswer.trim())
  const canSubmitMathAnswer =
    joined &&
    isMathLive &&
    Boolean(game.math?.currentTask) &&
    !game.math?.awaitingNext &&
    Boolean(mathAnswer.trim())
  const showMathRetryButton =
    joined &&
    isMathLive &&
    Boolean(game.math?.currentTask) &&
    Boolean(game.math?.lastResult?.canRetry)
  const showMathNextButton =
    joined &&
    isMathLive &&
    !game.math?.currentTask &&
    Boolean(game.math?.awaitingNext)
  const canJoinRoom =
    isHomeMathJoin
      ? Boolean(name.trim()) && /^\d{4}$/.test(learnerCode)
      : roomPreview.valid && (isMathPreview ? /^\d{4}$/.test(learnerCode) : Boolean(name.trim()))
  const showPlayerSidebar = game.mode !== "math"
  const selfPracticeQuestion = isSelfPracticeActive ? selfPracticeSession.questions?.[selfPracticeSession.currentIndex] || null : null
  const selfPracticeResult = isSelfPracticeActive ? selfPracticeSession.currentResult || null : null
  const selfPracticeAnsweredCount = isSelfPracticeActive ? selfPracticeSession.answers.length : 0
  const selfPracticeCorrectCount = isSelfPracticeActive
    ? selfPracticeSession.answers.filter((entry) => entry.correct).length
    : 0
  const selfPracticeIsTypedQuestion = selfPracticeQuestion?.questionType === "typed"
  const canStartSelfPractice =
    isHomeMathJoin &&
    Boolean(learnerPortal) &&
    selfPracticeTopic.trim().length >= 2 &&
    !isSelfPracticeActive &&
    !isLiveMathRoute &&
    !isLocalHomeMath
  const shouldShowHomeMathPortal = isHomeMathJoin && !isLocalHomeMath && !isSelfPracticeActive && !isLiveMathRoute

  if (isLocalHomeMath) {
    return (
      <main className="page-shell player-shell">
        <section className="player-layout">
          <div className="glass join-card">
            <span className="eyebrow">Deelnemen</span>
            <h1>Zelf oefenen</h1>
            <p className="muted">{status}</p>

            <div className="mode-switch join-mode-switch">
              <button
              className={`mode-chip ${joinMode === PLAYER_JOIN_MODE_CLASSROOM ? "is-active" : ""}`}
                onClick={() => {
                  setJoinMode(PLAYER_JOIN_MODE_CLASSROOM)
                  setJoinCodeLockedFromUrl(Boolean(joinSessionCodeFromUrl))
                  if (joinSessionCodeFromUrl) setRoomCode(joinSessionCodeFromUrl)
                  setHomeMathSession(null)
                  resetLearnerLiveState()
                  setStatus(
                    joinSessionCodeFromUrl
                      ? "Sessiecode is al ingevuld via de QR-code. Vul alleen je naam in."
                      : "Vul je gegevens in en sluit aan."
                  )
                }}
                type="button"
              >
                In de klas
              </button>
              <button
                className={`mode-chip ${isHomeMathJoin ? "is-active" : ""}`}
                onClick={() => {
                  setJoinMode(PLAYER_JOIN_MODE_HOME_MATH)
                  setJoinCodeLockedFromUrl(false)
                  resetLearnerLiveState()
                  setLearnerPortal(null)
                  setHomeMathSession(null)
                  setSelfPracticeSession(null)
                  setStatus("Log in met je naam en leerlingcode om zelfstandig te oefenen.")
                }}
                type="button"
              >
                Zelf oefenen
              </button>
            </div>

            <label className="field">
              <span>Jouw naam</span>
              <input
                autoCapitalize="words"
                autoComplete="nickname"
                ref={nameInputRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Bijv. Amina"
              />
            </label>

            <label className="field">
              <span>Leerlingcode</span>
              <input
                inputMode="numeric"
                maxLength={4}
                value={learnerCode}
                onChange={(event) => setLearnerCode(event.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="Bijv. 4821"
              />
            </label>

            <button className="button-primary" disabled={!canJoinRoom} onClick={join} type="button">
              Oefenroute openen
            </button>

            <p className="muted learner-code-note">
              Je opgeslagen oefenroute staat op dit apparaat klaar. Vul alleen je naam en leerlingcode in om door te gaan.
            </p>
          </div>

          <div className="glass battle-card">
            <div className="section-head">
              <h2>Jouw rekenroute</h2>
              <div className="pill-row">
                <span className="pill timer-pill">
                  {homeMathSession.placementLevel ? `Route ${homeMathSession.targetLevel || homeMathSession.placementLevel}` : `Instap ${homeMathSession.selectedBand}`}
                </span>
                <span className="pill">
                  {homeMathSession.phase === "practice"
                    ? `${homeMathSession.practiceQuestionCount || 0} sommen gemaakt`
                    : `Instap ${Math.min((homeMathSession.intakeIndex || 0) + (homeMathSession.currentTask ? 1 : 0), homeMathSession.intakeTotal || 0)} / ${homeMathSession.intakeTotal || 0}`}
                </span>
              </div>
            </div>

            <MathStudentPanel
              math={homeMathSession}
              answer={mathAnswer}
              onAnswerChange={setMathAnswer}
              onNext={goToNextMathTask}
              onRetry={retryMathIntakeAnswer}
              onSubmit={submitMathAnswer}
              canSubmit={Boolean(homeMathSession.currentTask) && !homeMathSession.awaitingNext && Boolean(mathAnswer.trim())}
              showRetryButton={Boolean(homeMathSession.currentTask) && Boolean(homeMathSession.lastResult?.canRetry)}
              showNextButton={!homeMathSession.currentTask && Boolean(homeMathSession.awaitingNext)}
            />
          </div>

          <div className="glass side-column">
            <LearnerCodeCard learnerCode={learnerCode} roomCode={roomCode} />
          </div>
        </section>
      </main>
    )
  }

  if (isSelfPracticeActive) {
    const selfPracticeIsFinished = Boolean(selfPracticeSession.finishedAt)
    const selfPracticeAccuracy = selfPracticeAnsweredCount
      ? Math.round((selfPracticeCorrectCount / Math.max(1, selfPracticeAnsweredCount)) * 100)
      : 0

    return (
      <main className="page-shell player-shell">
        <section className="player-layout">
          <div className="glass join-card">
            <span className="eyebrow">Zelf oefenen</span>
            <h1>{selfPracticeSession.title}</h1>
            <p className="muted">{status}</p>
            <div className="lesson-library-meta">
              <span>{selfPracticeSession.topic || "Algemeen onderwerp"}</span>
              <span>{getPracticeQuestionFormatLabel(selfPracticeSession.questionFormat)}</span>
              <span>{selfPracticeSession.providerLabel}</span>
            </div>
            <button
              className="button-ghost"
              onClick={() => {
                setSelfPracticeSession(null)
                setPracticeTextAnswer("")
                setChosenAnswer(null)
                setAnswerLocked(false)
                setStatus("Kies hieronder een nieuw onderwerp om verder te oefenen.")
              }}
              type="button"
            >
              Kies een nieuwe oefentoets
            </button>
          </div>

          <div className="glass battle-card">
            <div className="section-head">
              <h2>{selfPracticeIsFinished ? "Jouw resultaat" : "Jouw oefenvraag"}</h2>
              <div className="pill-row">
                <span className="pill timer-pill">
                  {selfPracticeIsFinished
                    ? `${selfPracticeCorrectCount}/${selfPracticeAnsweredCount} goed`
                    : `Vraag ${Math.min(selfPracticeSession.currentIndex + 1, selfPracticeSession.questions.length)} / ${selfPracticeSession.questions.length}`}
                </span>
                <span className="pill">{selfPracticeAccuracy}% score</span>
              </div>
            </div>

            {selfPracticeIsFinished ? (
              <div className="results-card">
                <span className="eyebrow">Oefentoets afgerond</span>
                <h3>Netjes gewerkt</h3>
                <p>
                  Je maakte {selfPracticeAnsweredCount} vragen over <strong>{selfPracticeSession.topic}</strong> en had {selfPracticeCorrectCount} goed.
                </p>
                <div className="score-breakdown">
                  <span className="score-chip">Score {selfPracticeAccuracy}%</span>
                  <span className="score-chip">{getPracticeQuestionFormatLabel(selfPracticeSession.questionFormat)}</span>
                </div>
              </div>
            ) : (
              <>
                <ProgressBar current={selfPracticeSession.currentIndex + 1} total={selfPracticeSession.questions.length} timeLeft={0} duration={0} />
                <QuestionCard question={selfPracticeQuestion} compact={false} showOptions={false} />
                {selfPracticeIsTypedQuestion ? (
                  <div className="typed-practice-panel">
                    <div className="typed-practice-card">
                      <span className="visual-label">Zelf typen</span>
                      <strong>Typ je antwoord</strong>
                      <p>{selfPracticeSession.instructions}</p>
                    </div>
                    <div className="typed-practice-form">
                      <input
                        className="typed-practice-input"
                        disabled={Boolean(selfPracticeResult)}
                        onChange={(event) => setPracticeTextAnswer(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return
                          event.preventDefault()
                          if (!practiceTextAnswer.trim() || selfPracticeResult) return
                          submitSelfPracticeAnswer({ answerText: practiceTextAnswer })
                        }}
                        placeholder={selfPracticeQuestion?.answerPlaceholder || "Typ hier je antwoord"}
                        value={practiceTextAnswer}
                      />
                      <button
                        className="button-primary typed-practice-submit"
                        disabled={!practiceTextAnswer.trim() || Boolean(selfPracticeResult)}
                        onClick={() => submitSelfPracticeAnswer({ answerText: practiceTextAnswer })}
                        type="button"
                      >
                        Check antwoord
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="answer-grid">
                    {selfPracticeQuestion?.options?.map((option, index) => {
                      const isCorrectChoice =
                        Boolean(selfPracticeResult && typeof selfPracticeResult.correctIndex === "number" && index === selfPracticeResult.correctIndex)
                      const isWrongChosen = Boolean(selfPracticeResult && selfPracticeResult.correct === false && index === chosenAnswer)

                      return (
                        <button
                          key={`${selfPracticeQuestion?.id}-${index}`}
                          className={`answer-button ${chosenAnswer === index ? "is-selected" : ""} ${isCorrectChoice ? "is-correct" : ""} ${isWrongChosen ? "is-wrong" : ""}`}
                          disabled={Boolean(selfPracticeResult)}
                          onClick={() => {
                            if (selfPracticeResult) return
                            setChosenAnswer(index)
                            submitSelfPracticeAnswer({ answerIndex: index })
                          }}
                          type="button"
                        >
                          <span>{String.fromCharCode(65 + index)}</span>
                          <strong>{option}</strong>
                        </button>
                      )
                    })}
                  </div>
                )}

                {selfPracticeResult ? (
                  <div className={`answer-result ${selfPracticeResult.correct ? "ok" : "bad"}`}>
                    <strong>{selfPracticeResult.correct ? "Goed antwoord" : "Nog niet goed"}</strong>
                    <p>{selfPracticeResult.explanation || "Kijk rustig naar de uitleg en ga daarna verder."}</p>
                    {selfPracticeResult.questionType === "typed" ? (
                      <div className="typed-answer-summary">
                        <span>Jouw antwoord: {selfPracticeResult.answerText || "geen antwoord"}</span>
                        <span>Goed antwoord: {selfPracticeResult.correctAnswer || "niet beschikbaar"}</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {selfPracticeResult ? (
                  <button className="button-secondary practice-next-button" onClick={goToNextSelfPracticeQuestion} type="button">
                    {selfPracticeSession.currentIndex + 1 >= selfPracticeSession.questions.length ? "Bekijk resultaat" : "Volgende vraag"}
                  </button>
                ) : null}
              </>
            )}
          </div>

          <div className="glass side-column">
            <LearnerCodeCard learnerCode={learnerCode} roomCode={roomCode} />
            <div className="result-tile">
              <span>Gemaakt</span>
              <strong>{selfPracticeAnsweredCount}</strong>
            </div>
            <div className="result-tile">
              <span>Goed</span>
              <strong>{selfPracticeCorrectCount}</strong>
            </div>
          </div>
        </section>
      </main>
    )
  }

  if (shouldShowHomeMathPortal) {
    return (
      <main className="page-shell player-shell">
        <section className="player-layout">
          <div className="glass join-card">
            <span className="eyebrow">Leerlinglogin</span>
            <h1>Zelf oefenen</h1>
            <p className="muted">{status}</p>

            <div className="mode-switch join-mode-switch">
              <button
                className={`mode-chip ${joinMode === PLAYER_JOIN_MODE_CLASSROOM ? "is-active" : ""}`}
                onClick={() => {
                  setJoinMode(PLAYER_JOIN_MODE_CLASSROOM)
                  setJoinCodeLockedFromUrl(Boolean(joinSessionCodeFromUrl))
                  if (joinSessionCodeFromUrl) setRoomCode(joinSessionCodeFromUrl)
                  setLearnerPortal(null)
                  setSelfPracticeSession(null)
                  setHomeMathSession(null)
                  resetLearnerLiveState()
                }}
                type="button"
              >
                Klassikaal meedoen
              </button>
              <button
                className={`mode-chip ${isHomeMathJoin ? "is-active" : ""}`}
                onClick={() => {
                  setJoinMode(PLAYER_JOIN_MODE_HOME_MATH)
                  setJoinCodeLockedFromUrl(false)
                  resetLearnerLiveState()
                  setLearnerPortal(null)
                  setHomeMathSession(null)
                  setSelfPracticeSession(null)
                  setStatus("Log in met je naam en leerlingcode om zelfstandig te oefenen.")
                }}
                type="button"
              >
                Zelf oefenen
              </button>
            </div>

            <label className="field">
              <span>Jouw naam</span>
              <input
                autoCapitalize="words"
                autoComplete="nickname"
                ref={nameInputRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Bijv. Layan"
              />
            </label>

            <label className="field">
              <span>Leerlingcode</span>
              <input
                inputMode="numeric"
                maxLength={4}
                value={learnerCode}
                onChange={(event) => setLearnerCode(event.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="Bijv. 1122"
              />
            </label>

            <button className="button-primary" disabled={!canJoinRoom} onClick={join} type="button">
              Inloggen als leerling
            </button>

            <p className="muted learner-code-note">
              Na het inloggen kun je een oefentoets kiezen of je rekenroute hervatten als die al klaarstaat.
            </p>
          </div>

          <div className="glass battle-card">
            {!learnerPortal ? (
              <div className="empty-state">
                <h3>Kies hoe je wilt oefenen</h3>
                <p>
                  Log eerst in met je naam en leerlingcode. Daarna kun je zelfstandig een oefentoets starten of verdergaan met rekenen.
                </p>
              </div>
            ) : (
              <>
                <div className="section-head">
                  <h2>Welkom {learnerPortal.name}</h2>
                  <div className="pill-row">
                    {learnerPortal.className ? <span className="pill">{learnerPortal.className}</span> : null}
                    <span className="pill">{learnerPortal.audience || "vmbo"}</span>
                  </div>
                </div>

                <div className="lesson-summary-grid">
                  <div className="lesson-box">
                    <strong>Verder met rekenen</strong>
                    <p>
                      {learnerPortal.canResumeMath
                        ? "We hebben eerdere rekenvoortgang gevonden. Als er een actieve route klaarstaat, laden we die automatisch."
                        : "Er staat nu geen actieve rekenroute klaar, maar je kunt wel zelfstandig een oefentoets maken."}
                    </p>
                    {learnerPortal.growthSummary?.lastPracticedAt ? (
                      <span className="pill">Laatst geoefend: {formatHistoryDate(learnerPortal.growthSummary.lastPracticedAt)}</span>
                    ) : null}
                  </div>
                  <div className="lesson-box accent-box practice-box">
                    <strong>Start een oefentoets</strong>
                    <p>Kies een onderwerp en laat Lesson Battle meteen oefenvragen voor je klaarzetten.</p>
                    <div className="lesson-library-edit-grid">
                      <label className="field inline-field">
                        <span>Onderwerp</span>
                        <input
                          onChange={(event) => setSelfPracticeTopic(event.target.value)}
                          placeholder="Bijv. Marokko, werkwoordspelling of breuken"
                          value={selfPracticeTopic}
                        />
                      </label>
                      <label className="field inline-field">
                        <span>Aantal vragen</span>
                        <input
                          max="24"
                          min="6"
                          onChange={(event) => setSelfPracticeQuestionCount(Number(event.target.value))}
                          type="number"
                          value={selfPracticeQuestionCount}
                        />
                      </label>
                      <label className="field inline-field">
                        <span>Vorm</span>
                        <select onChange={(event) => setSelfPracticeQuestionFormat(event.target.value)} value={selfPracticeQuestionFormat}>
                          {PRACTICE_QUESTION_FORMAT_OPTIONS.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="lesson-library-actions">
                      <button className="button-secondary" disabled={!canStartSelfPractice} onClick={startSelfPractice} type="button">
                        Start oefentoets
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="glass side-column">
            {learnerCode ? <LearnerCodeCard learnerCode={learnerCode} roomCode={roomCode} /> : null}
            <div className="result-tile">
              <span>Zelf oefenen</span>
              <strong>Naam + leerlingcode</strong>
            </div>
            <div className="result-tile">
              <span>Klassikaal meedoen</span>
              <strong>Naam + sessiecode</strong>
            </div>
          </div>
        </section>
      </main>
    )
  }

  if (!joined) {
    return (
      <main className="page-shell player-shell">
        <section className="player-layout">
          <div className="glass join-card">
            <span className="eyebrow">Deelnemen</span>
            <h1>Doe mee met de klas</h1>
            <p className="muted">{status}</p>

            <div className="mode-switch join-mode-switch">
              <button
                className={`mode-chip ${joinMode === PLAYER_JOIN_MODE_CLASSROOM ? "is-active" : ""}`}
                onClick={() => {
                  setJoinMode(PLAYER_JOIN_MODE_CLASSROOM)
                  setJoinCodeLockedFromUrl(Boolean(joinSessionCodeFromUrl))
                  if (joinSessionCodeFromUrl) setRoomCode(joinSessionCodeFromUrl)
                  resetLearnerLiveState()
                }}
                type="button"
              >
                Klassikaal meedoen
              </button>
              <button
                className={`mode-chip ${isHomeMathJoin ? "is-active" : ""}`}
                onClick={() => {
                  setJoinMode(PLAYER_JOIN_MODE_HOME_MATH)
                  setJoinCodeLockedFromUrl(false)
                  setLearnerPortal(null)
                  resetLearnerLiveState()
                  setHomeMathSession(null)
                  setSelfPracticeSession(null)
                  setStatus("Log in met je naam en leerlingcode om zelfstandig te oefenen.")
                }}
                type="button"
              >
                Zelf oefenen
              </button>
            </div>

            <label className="field">
              <span>Jouw naam</span>
              <input
                autoCapitalize="words"
                autoComplete="nickname"
                ref={nameInputRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Bijv. Layan"
              />
            </label>

            {joinGroupModeEnabled ? (
              <label className="field">
                <span>Groep (optioneel)</span>
                <select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
                  <option value="">Geen groep</option>
                  {availableTeams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="field">
              <span>Sessiecode</span>
              {joinCodeLockedFromUrl ? (
                <div className="prefilled-session-code">
                  <strong>{roomCode || "-----"}</strong>
                  <span>Deze sessiecode is al ingevuld via de QR-code.</span>
                </div>
              ) : (
                <input
                  value={roomCode}
                  onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
                  placeholder="Bijv. AB12C"
                />
              )}
            </label>

            <button className="button-primary" disabled={!canJoinRoom} onClick={join} type="button">
              Ik doe klassikaal mee
            </button>

            {!isHomeMathJoin ? (
              <div className="join-home-note">
                <strong>Wil je zelfstandig oefenen?</strong>
                <p>Kies hierboven Zelf oefenen. Dan log je in met je naam en leerlingcode en kies je daarna zelf een oefentoets.</p>
              </div>
            ) : null}
          </div>

          <div className="glass battle-card">
            <div className="empty-state">
              <h3>Klassikaal meedoen</h3>
              <p>
                Vul je naam en sessiecode in. Daarna kom je pas in de live les, presentatie, oefentoets of battle van je docent.
              </p>
            </div>
          </div>

          <div className="glass side-column">
            <div className="result-tile">
              <span>Stap 1</span>
              <strong>Naam invullen</strong>
            </div>
            <div className="result-tile">
              <span>Stap 2</span>
              <strong>Sessiecode invullen</strong>
            </div>
            <div className="result-tile">
              <span>Stap 3</span>
              <strong>Wachten op start</strong>
            </div>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="page-shell player-shell">
      <section className="player-layout">
        <div className="glass join-card">
          <span className="eyebrow">Deelnemen</span>
          <h1>{isHomeMathJoin ? "Zelf oefenen" : isMathPreview ? "Start rekenen" : "Doe mee aan de sessie"}</h1>
          <p className="muted">{status}</p>

          <div className="mode-switch join-mode-switch">
            <button
              className={`mode-chip ${joinMode === PLAYER_JOIN_MODE_CLASSROOM ? "is-active" : ""}`}
              onClick={() => {
                setJoinMode(PLAYER_JOIN_MODE_CLASSROOM)
                setJoinCodeLockedFromUrl(Boolean(joinSessionCodeFromUrl))
                if (joinSessionCodeFromUrl) setRoomCode(joinSessionCodeFromUrl)
                resetLearnerLiveState()
              }}
              type="button"
            >
              In de klas
            </button>
            <button
              className={`mode-chip ${isHomeMathJoin ? "is-active" : ""}`}
              onClick={() => {
                setJoinMode(PLAYER_JOIN_MODE_HOME_MATH)
                setJoinCodeLockedFromUrl(false)
                resetLearnerLiveState()
                setLearnerPortal(null)
                setHomeMathSession(null)
                setSelfPracticeSession(null)
                setStatus("Log in met je naam en leerlingcode om zelfstandig te oefenen.")
              }}
              type="button"
            >
              Zelf oefenen
            </button>
          </div>

          <label className="field">
            <span>Jouw naam</span>
            <input
              autoCapitalize="words"
              autoComplete="nickname"
              ref={nameInputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Bijv. Amina"
            />
          </label>

          {joinGroupModeEnabled ? (
            <label className="field">
              <span>Groep (optioneel)</span>
              <select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
                <option value="">Geen groep</option>
                {availableTeams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {needsRoomCode ? (
            <label className="field">
              <span>Sessiecode</span>
              {joinCodeLockedFromUrl ? (
                <div className="prefilled-session-code">
                  <strong>{roomCode || "-----"}</strong>
                  <span>Deze sessiecode is al ingevuld via de QR-code.</span>
                </div>
              ) : (
                <input
                  value={roomCode}
                  onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
                  placeholder="Bijv. AB12C"
                />
              )}
            </label>
          ) : null}

          {needsLearnerCode ? (
            <label className="field">
              <span>Leerlingcode</span>
              <input
                inputMode="numeric"
                maxLength={4}
                value={learnerCode}
                onChange={(event) => setLearnerCode(event.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="Bijv. 4821"
              />
            </label>
          ) : null}

          <button className="button-primary" disabled={!canJoinRoom} onClick={join} type="button">
            {joined ? "Opnieuw koppelen" : isHomeMathJoin ? "Leerlinglogin starten" : "Ik doe mee"}
          </button>

          {selectedTeam && joinGroupModeEnabled ? (
            <div className="team-chip" style={{ "--team-accent": selectedTeam.color }}>
              {selectedTeam.name}
            </div>
          ) : null}
          {needsLearnerCode ? (
            <p className="muted learner-code-note">
              {isHomeMathJoin
                ? "Vul je naam en leerlingcode in. Dan zoeken we jouw rekenroute automatisch op."
                : "Vul hier de 4-cijferige code in die je van de docent hebt gekregen."}
            </p>
          ) : null}
          {joinCodeLockedFromUrl && !needsLearnerCode ? (
            <p className="muted learner-code-note">
              De sessiecode staat al klaar via de QR-code. Je hoeft dus alleen nog je naam in te vullen.
            </p>
          ) : null}
          {!isHomeMathJoin ? (
            <div className="join-home-note">
              <strong>Thuis verder?</strong>
              <p>Klik hierboven op Zelf oefenen. Dan vul je alleen je naam en leerlingcode in. Een sessiecode is daar niet nodig.</p>
            </div>
          ) : null}
        </div>

        <div className="glass battle-card">
          <div className="section-head">
            <h2>{game.mode === "lesson" ? "Jouw lesstap" : game.mode === "math" ? "Jouw rekenroute" : "Jouw battlevraag"}</h2>
            <div className="pill-row">
              <span className="pill timer-pill">
                {game.mode === "lesson"
                  ? game.lesson?.currentPhase
                    ? `${game.lesson.currentPhase.minutes} min`
                    : "Wachten"
                  : game.mode === "math"
                    ? game.math?.placementLevel
                      ? `Route ${game.math.targetLevel || game.math.placementLevel}`
                      : game.math?.selectedBand
                        ? `Instap ${game.math.selectedBand}`
                        : "Rekenen"
                  : game.status === "preview"
                    ? "Wacht"
                  : game.status === "live"
                    ? `${timeLeft}s`
                    : game.status === "revealed"
                      ? "Uitleg"
                      : "Wacht"}
              </span>
              <span className="pill">
                {game.mode === "lesson"
                  ? game.status === "live"
                    ? `Fase ${game.currentPhaseIndex + 1}`
                    : "Wachten"
                  : game.mode === "math"
                    ? game.math?.phase === "practice"
                      ? `${game.math.practiceQuestionCount || 0} sommen gemaakt`
                      : `Instap ${Math.min((game.math?.intakeIndex || 0) + (game.math?.currentTask ? 1 : 0), game.math?.intakeTotal || 0)} / ${game.math?.intakeTotal || 0}`
                  : game.status === "preview"
                    ? "De docent zet zo de vraag live"
                  : game.status === "live"
                    ? `Vraag ${game.currentQuestionIndex + 1}`
                    : game.status === "revealed"
                      ? "Antwoord"
                    : "Wachten"}
              </span>
            </div>
          </div>

          {game.mode === "battle" ? (
            <div className="player-score-strip">
              <div className="player-score-pill">
                <span>Jij</span>
                <strong>{currentPlayer?.score ?? 0}</strong>
              </div>
              <div className="player-score-pill">
                <span>{liveGroupModeEnabled ? "Jouw groep" : "Koploper"}</span>
                <strong>{liveGroupModeEnabled ? currentTeam?.score ?? 0 : leaderboard[0]?.score ?? 0}</strong>
              </div>
              <div className="player-score-pill">
                <span>Plek</span>
                <strong>{currentRank ? `#${currentRank}` : "-"}</strong>
              </div>
            </div>
          ) : null}

          {game.mode === "math" && game.math ? (
            <MathStudentPanel
              math={game.math}
              answer={mathAnswer}
              onAnswerChange={setMathAnswer}
              onNext={goToNextMathTask}
              onRetry={retryMathIntakeAnswer}
              onSubmit={submitMathAnswer}
              canSubmit={canSubmitMathAnswer}
              showRetryButton={showMathRetryButton}
              showNextButton={showMathNextButton}
            />
          ) : game.mode === "lesson" && game.lesson?.currentPhase ? (
            <>
              {hasLessonPresentation ? (
                <LessonPresentationPanel compact presentation={game.lesson?.presentation} />
              ) : (
                <LessonStageCard lesson={game.lesson} />
              )}
              {hasLessonPrompt ? (
                <LessonResponsePanel
                  answer={lessonAnswer}
                  disabled={!joined}
                  onChange={setLessonAnswer}
                  onSubmit={submitLessonAnswer}
                  prompt={game.lesson?.currentPhase?.prompt}
                  result={lessonResult}
                />
              ) : null}
            </>
          ) : game.question ? (
            <>
              {game.mode === "battle" && liveGroupModeEnabled ? <BattleRaceBanner game={game} teams={teams} /> : null}
              <ProgressBar current={game.currentQuestionIndex + 1} total={game.totalQuestions} timeLeft={timeLeft} duration={game.questionDurationSec} />
              <QuestionCard question={game.question} compact={false} showOptions={false} />
              {game.status === "live" || isPracticeTestLive || battleRevealVisible || result ? (
                isTypedPracticeQuestion ? (
                  <div className="typed-practice-panel">
                    <div className="typed-practice-card">
                      <span className="visual-label">Flashcard</span>
                      <strong>Typ het antwoord zelf</strong>
                      <p>
                        Deze oefenvraag werkt zonder antwoordknoppen. Typ je antwoord en druk op Enter.
                      </p>
                    </div>
                    <div className="typed-practice-form">
                      <input
                        className="typed-practice-input"
                        disabled={!canSubmitQuestion}
                        onChange={(event) => setPracticeTextAnswer(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return
                          event.preventDefault()
                          if (!canSubmitTypedAnswer) return
                          setAnswerLocked(true)
                          setStatus("Antwoord wordt nagekeken. Wacht heel even.")
                          socket.emit("player:answer", { typedAnswer: practiceTextAnswer })
                        }}
                        placeholder={game.question.answerPlaceholder || "Typ hier je antwoord"}
                        value={practiceTextAnswer}
                      />
                      <button
                        className="button-primary typed-practice-submit"
                        disabled={!canSubmitTypedAnswer}
                        onClick={() => {
                          if (!canSubmitTypedAnswer) return
                          setAnswerLocked(true)
                          setStatus("Antwoord wordt nagekeken. Wacht heel even.")
                          socket.emit("player:answer", { typedAnswer: practiceTextAnswer })
                        }}
                        type="button"
                      >
                        Check antwoord
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="answer-grid">
                    {game.question.options.map((option, index) => {
                      const isCorrectChoice =
                        (result && typeof result.correctIndex === "number" && index === result.correctIndex) ||
                        (battleRevealVisible && index === game.question.correctIndex)
                      const isWrongChosen =
                        Boolean(result && result.correct === false && index === chosenAnswer) ||
                        Boolean(battleRevealVisible && chosenAnswer === index && index !== game.question.correctIndex)

                      return (
                        <button
                          key={`${game.question.id}-${index}`}
                          className={`answer-button ${chosenAnswer === index ? "is-selected" : ""} ${isCorrectChoice ? "is-correct" : ""} ${isWrongChosen ? "is-wrong" : ""}`}
                          disabled={!canSubmitChoiceAnswer}
                          onClick={() => {
                            if (!canSubmitChoiceAnswer) return
                            setChosenAnswer(index)
                            setAnswerLocked(true)
                            setStatus("Antwoord verstuurd. Wacht heel even op de bevestiging.")
                            socket.emit("player:answer", { answer: index })
                          }}
                          type="button"
                        >
                          <span>{String.fromCharCode(65 + index)}</span>
                          <strong>{option}</strong>
                        </button>
                      )
                    })}
                  </div>
                )
              ) : (
                <div className="answer-result">
                  <strong>De vraag wordt zo gestart</strong>
                  <p>Wacht tot de beheerder de vraag live zet. Daarna kun je direct een antwoord kiezen.</p>
                </div>
              )}
              {result?.waitingForReveal && !battleRevealVisible ? (
                <div className="answer-result">
                  <strong>Antwoord ontvangen</strong>
                  <p>Wacht tot de beheerder het juiste antwoord laat zien.</p>
                </div>
              ) : null}
              {battleRevealVisible ? (
                <div className={`answer-result ${result ? (result.correct ? "ok" : "bad") : chosenAnswer === game.question.correctIndex ? "ok" : ""}`}>
                  <strong>
                    {result
                      ? result.correct
                        ? `Goed! +${result.awardedPoints || 0} punten`
                        : "Niet goed deze keer"
                      : chosenAnswer === game.question.correctIndex
                        ? "Goed antwoord"
                        : "Juiste antwoord"}
                  </strong>
                  <p>
                    {game.question.options[game.question.correctIndex]}
                    {game.question.explanation ? ` — ${game.question.explanation}` : ""}
                  </p>
                  {result ? (
                    <div className="score-breakdown">
                      <span className="score-chip">Score totaal {result.playerScore}</span>
                      {liveGroupModeEnabled ? <span className="score-chip">Groep {result.teamScore}</span> : null}
                      {result.correct ? <span className="score-chip">Snelheid +{result.speedBonus || 0}</span> : null}
                      {result.multiplier > 1 ? <span className="score-chip">x{result.multiplier} punten</span> : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {result && !result.waitingForReveal && !battleRevealVisible ? (
                <div className={`answer-result ${result.correct ? "ok" : "bad"}`}>
                  <strong>{result.correct ? `Correct • +${result.awardedPoints || 0}` : "Niet correct"}</strong>
                  <p>{result.explanation}</p>
                  {result.questionType === "typed" ? (
                    <div className="typed-answer-summary">
                      <span>Jouw antwoord: {result.answerText || "geen antwoord"}</span>
                      <span>Goed antwoord: {result.correctAnswer || "niet beschikbaar"}</span>
                    </div>
                  ) : null}
                  {result.correct ? (
                    <div className="score-breakdown">
                      <span className="score-chip">Basis {result.basePoints || 0}</span>
                      <span className="score-chip">Snelheid +{result.speedBonus || 0}</span>
                      {result.multiplier > 1 ? <span className="score-chip">x{result.multiplier}</span> : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {isPracticeTestLive && canAdvancePracticeQuestion ? (
                <button
                  className="button-secondary practice-next-button"
                  onClick={() => {
                    socket.emit("player:practice-next")
                  }}
                  type="button"
                >
                  {isLastPracticeQuestion ? "Einde van de oefentoets" : "Volgende vraag"}
                </button>
              ) : null}
            </>
          ) : game.status === "finished" ? (
            game.mode === "lesson" ? (
              <LessonCompleteCard lesson={game.lesson} />
            ) : isPracticeTestLive ? (
              <PracticeCompleteCard />
            ) : (
              <ResultsCard teams={teams} leaderboard={leaderboard} showGroups={liveGroupModeEnabled} />
            )
          ) : (
            <div className="empty-state">
              <h3>{game.mode === "lesson" ? "De les verschijnt zo" : game.mode === "math" ? "De rekenroute verschijnt zo" : "Wacht op de volgende vraag"}</h3>
              <p>
                {game.mode === "lesson"
                  ? "De huidige lesstap verschijnt hier vanzelf zodra die live staat."
                  : game.mode === "math"
                    ? "Zodra de docent de rekenroute start, zie je hier je instaptoets en daarna je adaptieve sommen."
                  : "De docent bekijkt de vraag eerst en zet hem daarna live voor jou."}
              </p>
            </div>
          )}
        </div>

        {showPlayerSidebar || (game.mode === "math" && game.math && learnerCode) ? (
          <div className="glass side-column">
            {game.mode === "math" && game.math && learnerCode ? <LearnerCodeCard learnerCode={learnerCode} roomCode={roomCode} /> : null}
            {showPlayerSidebar ? <ScoreBoard teams={teams} leaderboard={leaderboard} compact showGroups={liveGroupModeEnabled} /> : null}
            {showPlayerSidebar ? <RosterBoard groupModeEnabled={liveGroupModeEnabled} players={players} teams={teams} compact /> : null}
          </div>
        ) : null}
      </section>
    </main>
  )
}

function MathBandSelector({ selectedBand, onChange }) {
  return (
    <section className="math-band-selector">
      <div className="section-head">
        <h3>Rekenen</h3>
        <span className="pill">Kies een route</span>
      </div>
      <p className="muted">Start met een F-route. De instaptoets bepaalt daarna op welk niveau de leerling verdergaat.</p>
      <div className="math-band-row">
        {MATH_LEVEL_OPTIONS.map((band) => (
          <button
            className={`mode-chip math-band-chip ${selectedBand === band ? "is-active" : ""}`}
            key={band}
            onClick={() => onChange(band)}
            type="button"
          >
            {formatMathLevelLabel(band)}
          </button>
        ))}
      </div>
    </section>
  )
}

function MathHostSummary({ math, players }) {
  if (!math) return null

  return (
    <div className="math-summary-row">
      <div className="player-score-pill">
        <span>Opdracht</span>
        <strong>{math.assignmentTitle || math.title || `Route ${math.selectedBand || "-"}`}</strong>
      </div>
      <div className="player-score-pill">
        <span>Instapvragen</span>
        <strong>{math.intakeTotal || 0}</strong>
      </div>
      {math.dueAt ? (
        <div className="player-score-pill">
          <span>Deadline</span>
          <strong>{formatHistoryDate(math.dueAt)}</strong>
        </div>
      ) : null}
      <div className="player-score-pill">
        <span>Actieve leerlingen</span>
        <strong>{players.length}</strong>
      </div>
      <div className="player-score-pill">
        <span>Oefenvragen samen</span>
        <strong>{(math.players || []).reduce((sum, player) => sum + (player.answeredCount || 0), 0)}</strong>
      </div>
    </div>
  )
}

function MathHostPanel({
  math,
  insights,
  onExportCsv,
  learnerCodeDrafts,
  localBackup,
  newMathLearner,
  onClearLocalBackup,
  onCreateLearner,
  onLearnerCodeChange,
  onLearnerCodeSave,
  onNewLearnerChange,
  onRestoreLocalBackup,
}) {
  const [showOverview, setShowOverview] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  if (!math) return null

  const playerRows = insights?.mode === "math" ? insights.players || [] : math.players || []
  const normalizedSearchTerm = String(searchTerm || "").trim().toLowerCase()
  const visiblePlayerRows = normalizedSearchTerm
    ? playerRows.filter((player) => `${player.name || ""} ${player.learnerCode || ""}`.toLowerCase().includes(normalizedSearchTerm))
    : playerRows
  const supportCounts = visiblePlayerRows.reduce(
    (accumulator, player) => {
      const label = getMathSupportLabel(player)
      if (label === "Zelfstandig") accumulator.independent += 1
      else if (label === "Extra uitleg nodig") accumulator.support += 1
      else accumulator.follow += 1
      return accumulator
    },
    { independent: 0, support: 0, follow: 0 }
  )
  const growthAwareCount = visiblePlayerRows.filter((player) => Number(player.growthSummary?.sessionCount) > 0).length
  const deadlineLabel = math.dueAt ? formatHistoryDate(math.dueAt) : ""

  return (
    <section className="math-host-panel">
      <div className="math-host-hero">
        <div>
          <span className="eyebrow">Adaptief rekenen</span>
          <h3>{math.assignmentTitle || math.title || `Rekenroute ${math.selectedBand}`}</h3>
          <p>
            Leerlingen maken eerst precies {math.intakeTotal || 0} instapvragen. Daarna krijgen ze automatisch sommen op het volgende niveau,
            met oplopende moeilijkheid als het goed gaat.{deadlineLabel ? ` Deadline: ${deadlineLabel}.` : ""}
          </p>
        </div>
        <div className="math-host-actions">
          <div className="math-summary-stack">
            {math.assignmentTitle ? <span className="score-chip">Opdracht {math.assignmentTitle}</span> : null}
            {math.className ? <span className="score-chip">Klas {math.className}</span> : null}
            {deadlineLabel ? <span className="score-chip">Deadline {deadlineLabel}</span> : null}
            <span className="score-chip">Doel {math.targetPracticeQuestionCount || 12} sommen</span>
            <span className="score-chip">Instap {math.intakeTotal || 0} vragen</span>
            <span className="score-chip">{math.intakeCount || 0} in intake</span>
            <span className="score-chip">{math.practiceCount || 0} aan het oefenen</span>
            <span className="score-chip">{supportCounts.support} extra hulp</span>
            <span className="score-chip">{supportCounts.independent} zelfstandig</span>
            <span className="score-chip">{growthAwareCount} met eerdere groei</span>
            {localBackup?.savedAt ? <span className="score-chip">Lokale backup {formatHistoryDate(localBackup.savedAt)}</span> : null}
          </div>
          <div className="math-host-actions-row">
            <button className="button-ghost" onClick={() => setShowOverview((current) => !current)} type="button">
              {showOverview ? "Verberg voortgang" : "Toon voortgang"}
            </button>
            <button className="button-ghost" onClick={onExportCsv} type="button">
              Exporteer CSV
            </button>
            {localBackup?.snapshot ? (
              <button className="button-secondary" onClick={onRestoreLocalBackup} type="button">
                Herstel lokale backup
              </button>
            ) : null}
            {localBackup?.snapshot ? (
              <button className="button-ghost" onClick={onClearLocalBackup} type="button">
                Wis backup
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {localBackup?.snapshot ? (
        <div className="math-backup-note">
          Deze gratis backup staat alleen op dit apparaat en in deze browser. Daarmee kun je een rekenroute later opnieuw openen,
          ook als Render de room tussendoor kwijt is geraakt.
        </div>
      ) : null}

      <div className="math-host-card">
        <div className="math-host-card-head">
          <div>
            <strong>Zoek leerling</strong>
            <span>Zoek op naam of leerlingcode om direct te zien hoe iemand werkt.</span>
          </div>
          <span className="pill">{visiblePlayerRows.length} zichtbaar</span>
        </div>
        <input
          className="math-code-input"
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder="Bijv. Amina of 4821"
          value={searchTerm}
        />
      </div>

      {showOverview ? (
        <div className="math-monitor-grid">
          {visiblePlayerRows.map((player) => (
            <article className="math-monitor-card" key={`${player.playerId}-overview`}>
              <strong>{player.name}</strong>
              <span>{player.workLabel || "Nog niet gestart"}</span>
              <b>{player.answeredCount || 0} gemaakt</b>
              <small>Ondersteuning: {getMathSupportLabel(player)}</small>
              <small>Focus: {(player.focusDomains || []).map(formatMathDomainLabel).join(", ") || "nog bepalen"}</small>
              <small>
                Groei: {player.growthSummary?.sessionCount ? `${player.growthSummary.sessionCount} routes · ${player.growthSummary.averageAccuracy || 0}% gemiddeld` : "eerste route"}
              </small>
              <small>
                Goed {player.correctCount || 0} · Fout {player.wrongCount || 0} · {formatAccuracy(player.accuracyRate || 0)}
              </small>
            </article>
          ))}
        </div>
      ) : null}

      <div className="math-host-card">
        <div className="math-host-card-head">
          <div>
            <strong>Leerlingcodes klaarzetten</strong>
            <span>
              {math.className
                ? `Deze route gebruikt de vaste klas ${math.className}. Voeg nieuwe leerlingen toe via Beheer > Klassen.`
                : "Voeg leerlingen toe en geef ze een eenvoudige 4-cijferige code."}
            </span>
          </div>
        </div>
        <div className="math-create-row">
          <input
            className="math-code-input"
            disabled={Boolean(math.classId)}
            onChange={(event) => onNewLearnerChange((current) => ({ ...current, name: event.target.value }))}
            placeholder="Naam leerling"
            value={newMathLearner.name}
          />
          <input
            className="math-code-input"
            disabled={Boolean(math.classId)}
            inputMode="numeric"
            maxLength={4}
            onChange={(event) =>
              onNewLearnerChange((current) => ({ ...current, learnerCode: event.target.value.replace(/\D/g, "").slice(0, 4) }))
            }
            placeholder="4 cijfers of leeg"
            value={newMathLearner.learnerCode}
          />
          <button className="button-primary" disabled={Boolean(math.classId)} onClick={onCreateLearner} type="button">
            Voeg toe
          </button>
        </div>
      </div>

      <div className="math-host-grid">
        {visiblePlayerRows.map((player) => (
          <article className="math-host-card" key={player.playerId}>
            <div className="math-host-card-head">
              <div>
                <strong>{player.name}</strong>
                <span>{player.connected ? "online" : "offline"} · code {player.learnerCode || "-"}</span>
              </div>
              <span className="pill">{player.phase === "practice" ? "Adaptief" : "Instaptoets"}</span>
            </div>
            <div className="math-host-meta">
              <span>Opdracht: {math.assignmentTitle || math.title || `Rekenroute ${math.selectedBand}`}</span>
              {math.className ? <span>Klas: {math.className}</span> : null}
              {deadlineLabel ? <span>Deadline: {deadlineLabel}</span> : null}
              <span>Opdrachtstatus: {player.assignmentStatus?.label || "Open"}</span>
              <span>Werkhouding: {player.workLabel || "Nog niet gestart"}</span>
              <span>Gemaakt: {player.answeredCount || 0}</span>
              <span>Goed: {player.correctCount || 0}</span>
              <span>Fout: {player.wrongCount || 0}</span>
              <span>Nauwkeurigheid: {formatAccuracy(player.accuracyRate || 0)}</span>
              <span>Laatste actief: {player.lastAnsweredAt ? formatHistoryDate(player.lastAnsweredAt) : "Nog geen activiteit"}</span>
              <span>Ondersteuning: {getMathSupportLabel(player)}</span>
              <span>Plaatsing: {player.placementLevel || "-"}</span>
              <span>Oefenniveau: {player.targetLevel || "-"}</span>
              <span>Moeilijkheid: {formatMathDifficultyLabel(player.practiceDifficulty)}</span>
              <span>Focus nu: {(player.focusDomains || []).map(formatMathDomainLabel).join(", ") || "nog bepalen"}</span>
              <span>
                Goed: {player.practiceCorrectCount || 0} / {player.practiceQuestionCount || 0}
              </span>
              <span>Trend: {getMathTrendLabel(player.answerHistory || [])}</span>
              <span>Huidige streak: {getMathRecentStreak(player.answerHistory || [])}</span>
              <span>
                Groei over tijd: {player.growthSummary?.sessionCount ? `${player.growthSummary.sessionCount} routes` : "eerste route"}
              </span>
              <span>
                Gemiddeld eerder: {player.growthSummary?.sessionCount ? `${player.growthSummary.averageAccuracy || 0}% goed` : "nog geen historie"}
              </span>
              <span>
                Laatst geoefend: {player.growthSummary?.lastPracticedAt ? formatHistoryDate(player.growthSummary.lastPracticedAt) : "nog niet eerder"}
              </span>
              {player.growthSummary?.lastPlacementLevel ? <span>Vorige plaatsing: {player.growthSummary.lastPlacementLevel}</span> : null}
              {player.growthSummary?.lastTargetLevel ? <span>Vorige oefenroute: {player.growthSummary.lastTargetLevel}</span> : null}
            </div>
            <div className="math-code-row">
              <input
                className="math-code-input"
                onChange={(event) => onLearnerCodeChange(player.playerId, event.target.value)}
                value={learnerCodeDrafts[player.playerId] ?? player.learnerCode ?? ""}
              />
              <button className="button-ghost" onClick={() => onLearnerCodeSave(player.playerId)} type="button">
                Bewaar code
              </button>
            </div>
            {player.currentTaskPrompt ? <p className="math-task-preview">{player.currentTaskPrompt}</p> : null}
            <div className="math-history-block">
              <strong>Laatste antwoorden</strong>
              {(player.answerHistory || []).length ? (
                <div className="math-history-list">
                  {[...(player.answerHistory || [])].reverse().map((entry) => (
                    <div className={`math-history-row ${entry.correct ? "is-correct" : "is-wrong"}`} key={`${player.playerId}-${entry.taskId}-${entry.answeredAt}`}>
                      <div className="math-history-head">
                        <strong>{entry.correct ? "Goed" : "Fout"}</strong>
                        <span>{entry.level || "-"} · {entry.domain || "rekenen"}</span>
                      </div>
                      <p>{entry.prompt}</p>
                      <small>
                        Leerling: {entry.answeredValue || "geen antwoord"} · Goed: {entry.expectedAnswer}
                      </small>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="math-task-preview">Nog geen beantwoorde vragen.</p>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function MathStudentPanel({ math, answer, onAnswerChange, onSubmit, onNext, onRetry, canSubmit, showNextButton, showRetryButton }) {
  if (!math) return null
  const deadlineLabel = math.dueAt ? formatHistoryDate(math.dueAt) : ""

  return (
    <section className="math-student-panel">
      <div className="math-student-strip">
        <span className="score-chip">Route {math.selectedBand || "-"}</span>
        {math.assignmentTitle ? <span className="score-chip">{math.assignmentTitle}</span> : null}
        {math.className ? <span className="score-chip">{math.className}</span> : null}
        {deadlineLabel ? <span className="score-chip">Deadline {deadlineLabel}</span> : null}
        {math.assignmentStatus?.label ? <span className="score-chip">Status {math.assignmentStatus.label}</span> : null}
        <span className="score-chip">Instap {Math.min((math.intakeIndex || 0) + (math.currentTask ? 1 : 0), math.intakeTotal || 0)} / {math.intakeTotal || 0}</span>
        {math.placementLevel ? <span className="score-chip">Jij zit op {math.placementLevel}</span> : null}
        {math.targetLevel ? <span className="score-chip">Je oefent op {math.targetLevel}</span> : null}
        {math.answeredCount ? <span className="score-chip">{math.answeredCount} gemaakt</span> : null}
        {math.answeredCount ? <span className="score-chip">{formatAccuracy(math.accuracyRate || 0)} goed</span> : null}
        {math.phase === "practice" ? <span className="score-chip">{formatMathDifficultyLabel(math.practiceDifficulty)}</span> : null}
        {math.phase === "practice" && (math.focusDomains || []).length ? (
          <span className="score-chip">Focus: {(math.focusDomains || []).map(formatMathDomainLabel).join(", ")}</span>
        ) : null}
      </div>

      {math.phase !== "practice" ? (
        <div className="math-task-card">
          <strong>Instaptoets</strong>
          <p>Je maakt eerst precies {math.intakeTotal || 0} vragen. Daarna bepaalt de site op welk niveau jij verder oefent.</p>
        </div>
      ) : null}

      {math.assignmentTitle || math.growthSummary?.sessionCount ? (
        <div className="math-task-card">
          <strong>{math.assignmentTitle || "Jouw rekenroute"}</strong>
          <p>
            {deadlineLabel ? `Werk aan deze route voor ${deadlineLabel}. ` : ""}
            {math.targetPracticeQuestionCount ? `Na de instap werk je toe naar ${math.targetPracticeQuestionCount} oefensommen. ` : ""}
            {math.growthSummary?.sessionCount
              ? `Je hebt al ${math.growthSummary.sessionCount} eerdere routes gedaan met gemiddeld ${math.growthSummary.averageAccuracy || 0}% goed.`
              : "Dit is je eerste opgeslagen route op deze leerlingcode."}
          </p>
        </div>
      ) : null}

      {math.currentTask ? (
        <article className="math-task-card">
          <span className="category-badge">{math.currentTask.domain}</span>
          <h3>{math.currentTask.prompt}</h3>
          {math.currentTask.hint ? <p className="muted">{math.currentTask.hint}</p> : null}
          <div className="math-answer-row">
            <input
              className="math-answer-input"
              inputMode="decimal"
              onChange={(event) => onAnswerChange(event.target.value)}
              placeholder="Typ je antwoord"
              value={answer}
            />
            <button className="button-primary" disabled={!canSubmit} onClick={onSubmit} type="button">
              Check
            </button>
          </div>
        </article>
      ) : null}

      {math.lastResult ? (
        <div className={`answer-result ${math.lastResult.correct ? "ok" : "bad"}`}>
          <strong>{math.lastResult.correct ? "Goed bezig" : "Nog even doorpakken"}</strong>
          <p>{math.lastResult.feedback}</p>
          {math.lastResult.explanation ? (
            <div className="math-explanation-box">
              <strong>Uitleg stap voor stap</strong>
              <p>{math.lastResult.explanation}</p>
            </div>
          ) : null}
          {math.lastResult.expectedAnswer ? <span className="score-chip">Juiste antwoord: {math.lastResult.expectedAnswer}</span> : null}
          {showRetryButton ? (
            <button className="button-ghost" onClick={onRetry} type="button">
              Pas antwoord aan
            </button>
          ) : null}
        </div>
      ) : null}

      {showNextButton ? (
        <button className="button-secondary practice-next-button" onClick={onNext} type="button">
          {math.phase === "practice" ? "Volgende som" : "Volgende vraag"}
        </button>
      ) : null}
    </section>
  )
}

function LearnerCodeCard({ learnerCode, roomCode }) {
  if (!learnerCode) return null

  return (
    <section className="learner-code-card">
      <span className="eyebrow">Verdergaan</span>
      <h3>Bewaar je leerlingcode</h3>
      <div className="learner-code-grid">
        <div>
          <span>Leercode</span>
          <strong>{learnerCode}</strong>
        </div>
        {roomCode ? (
          <div>
            <span>Sessiecode in de klas</span>
            <strong>{roomCode}</strong>
          </div>
        ) : null}
      </div>
      <p className="muted">In de klas gebruik je sessiecode + leerlingcode. Thuis ga je verder met alleen je naam + leerlingcode.</p>
    </section>
  )
}

function SessionQrPreviewCard({ roomCode, qrCodeUrl, onOpen }) {
  if (!roomCode || !qrCodeUrl) return null

  return (
    <button className="session-qr-card" onClick={onOpen} type="button">
      <img alt={`QR-code voor sessie ${roomCode}`} className="session-qr-image" src={qrCodeUrl} />
      <div className="session-qr-copy">
        <strong>Scan en start direct</strong>
        <span>Leerlingen komen meteen op de leerlingpagina met de sessiecode al ingevuld.</span>
      </div>
    </button>
  )
}

function SessionQrOverlay({ roomCode, qrCodeUrl, joinUrl, onClose }) {
  if (!roomCode || !qrCodeUrl || !joinUrl) return null

  return (
    <div className="qr-overlay">
      <button aria-label="Sluit leerling-QR" className="presenter-backdrop" onClick={onClose} type="button" />
      <section className="qr-stage-frame">
        <div className="qr-overlay-head">
          <div>
            <span className="eyebrow">Leerlingen laten instappen</span>
            <h2>Scan de QR-code</h2>
            <p>De sessiecode staat al klaar. Leerlingen hoeven alleen nog hun naam in te vullen.</p>
          </div>
          <span className="pill">Sessiecode {roomCode}</span>
        </div>
        <div className="qr-overlay-main">
          <img alt={`QR-code voor sessie ${roomCode}`} className="qr-overlay-image" src={qrCodeUrl} />
        </div>
        <div className="qr-overlay-foot">
          <div className="qr-overlay-link">
            <span>Directe link</span>
            <strong>{joinUrl}</strong>
          </div>
          <div className="presenter-actions">
            <button className="button-ghost" onClick={onClose} type="button">
              Sluit QR
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

function QuestionCard({ question, compact = false, showOptions = true, revealCorrect = false }) {
  const prompt = getQuestionPrompt(question)
  const isTypedQuestion = question?.questionType === "typed"
  const typedAnswerPreview = question?.displayAnswer || question?.acceptedAnswers?.[0] || ""

  return (
    <article className={`question-card ${compact ? "compact" : ""}`}>
      <div className="question-visual-wrap">
        <QuestionVisual question={question} />
      </div>
      <div className="question-body">
        <span className="category-badge">{question.category}</span>
        <h3>{prompt}</h3>
        {showOptions && isTypedQuestion ? (
          <div className="typed-question-preview">
            <strong>Leerling typt zelf het antwoord</strong>
            <p>{question.answerPlaceholder || "Typ hier je antwoord"}</p>
            {revealCorrect && typedAnswerPreview ? <span>Voorbeeldantwoord: {typedAnswerPreview}</span> : null}
          </div>
        ) : showOptions ? (
          <ul className="option-list">
            {question.options.map((option, index) => (
              <li
                className={
                  revealCorrect && typeof question.correctIndex === "number" && index === question.correctIndex
                    ? "is-correct"
                    : ""
                }
                key={`${question.id}-preview-${index}`}
              >
                <span>{index + 1}</span>
                {option}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  )
}

function LessonSummaryCard({ lesson, onSave, onStartPractice }) {
  if (!lesson) return null

  return (
    <section className="lesson-summary">
      <div className="section-head">
        <h3>Lesopzet</h3>
        <span className="pill">
          {lesson.model} · {lesson.durationMinutes} min
        </span>
      </div>
      <p className="lesson-goal">{lesson.lessonGoal}</p>
      <div className="lesson-summary-grid">
        <div className="lesson-box">
          <strong>Succescriteria</strong>
          <ul>
            {lesson.successCriteria.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        </div>
        <div className="lesson-box">
          <strong>Benodigdheden</strong>
          <ul>
            {(lesson.materials.length ? lesson.materials : ["Geen extra materialen opgegeven"]).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        {lesson.practiceTest ? (
          <div className="lesson-box accent-box practice-box">
            <strong>Oefentoets</strong>
            <p>{lesson.practiceTest.title}</p>
            <div className="lesson-library-meta">
              <span>{lesson.practiceTest.questions?.length || lesson.practiceTest.questionCount || 0} vragen klaar</span>
              <span>{getPracticeQuestionFormatLabel(lesson.practiceTest.questionFormat)}</span>
            </div>
            <div className="lesson-box-actions">
              {onStartPractice ? (
                <button className="button-secondary" onClick={onStartPractice} type="button">
                  Start oefentoets
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {lesson.presentation ? (
          <div className="lesson-box accent-box presentation-box">
            <strong>Presentatiepakket</strong>
            <p>{lesson.presentation.title}</p>
            <div className="lesson-library-meta">
              <span>{lesson.presentation.slideCount} dia's</span>
              {lesson.presentation.video ? <span>{lesson.presentation.video.sceneCount} videoscènes</span> : null}
            </div>
            {lesson.presentation.currentSlide ? (
              <div className="micro-slide">
                <b>{lesson.presentation.currentSlide.title}</b>
                <p>{lesson.presentation.currentSlide.studentViewText || lesson.presentation.currentSlide.focus}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="lesson-summary-actions">
        <span className="pill">
          {lesson.libraryId ? "Opgeslagen in bibliotheek" : "Nog niet opgeslagen"}
        </span>
        {onSave ? (
          <button className="button-secondary" onClick={onSave} type="button">
            {lesson.libraryId ? "Werk les op in bibliotheek" : "Sla op in bibliotheek"}
          </button>
        ) : null}
      </div>
    </section>
  )
}

function LessonProgress({ lesson }) {
  if (!lesson) return null

  const current = lesson.currentPhaseIndex >= 0 ? lesson.currentPhaseIndex + 1 : 0
  const total = lesson.totalPhases || lesson.phases?.length || 0
  const progress = total ? Math.max(0, Math.min(100, (current / total) * 100)) : 0

  return (
    <div className="progress-stack">
      <div className="progress-track lesson-track">
        <div className="progress-fill lesson-fill" style={{ width: `${progress}%` }} />
      </div>
    </div>
  )
}

function LessonStageCard({ lesson, hostView = false }) {
  if (!lesson?.currentPhase) return null

  const phase = lesson.currentPhase
  const currentPrompt = phase.prompt || phase.interactivePrompt || phase.goal

  if (!hostView) {
    return (
      <article className="lesson-stage-card student-stage-card">
        <div className="student-stage-top">
          <span className="category-badge">Live les</span>
          <span className="lesson-minutes">{phase.minutes} min</span>
        </div>
        <div className="student-stage-kicker">Wat ga je nu doen?</div>
        <h3>{phase.title || "Volg deze lesstap."}</h3>
        <div className="student-stage-prompt">
          <strong>Opdracht</strong>
          <p>{currentPrompt}</p>
        </div>
      </article>
    )
  }

  return (
    <article className="lesson-stage-card">
      <div className="lesson-stage-head">
        <div>
          <span className="category-badge">{lesson.model}</span>
          <h3>{lesson.title}</h3>
          <p className="muted">{lesson.lessonGoal}</p>
        </div>
        <div className="lesson-minutes">{phase.minutes} min</div>
      </div>

      <div className="lesson-phase-strip">
        {lesson.phases.map((item, index) => (
          <div className={`lesson-phase-chip ${index === lesson.currentPhaseIndex ? "is-current" : ""}`} key={item.id}>
            <span>{index + 1}</span>
            <strong>{item.title}</strong>
          </div>
        ))}
      </div>

      <div className="lesson-callout">
        <span>Huidige fase</span>
        <strong>{phase.title}</strong>
        <p>{currentPrompt}</p>
      </div>

      <div className="lesson-stage-grid">
        <div className="lesson-box">
          <strong>Docentregie</strong>
          <p>{phase.teacherScript}</p>
        </div>
        <div className="lesson-box">
          <strong>Leerlingen doen nu</strong>
          <p>{phase.studentActivity}</p>
        </div>
        <div className="lesson-box">
          <strong>Live vraag</strong>
          <p>{currentPrompt}</p>
        </div>
        <div className="lesson-box">
          <strong>Begrip checken</strong>
          <p>{phase.checkForUnderstanding}</p>
        </div>
      </div>
    </article>
  )
}

function SlideVisual({ slide, compact = false }) {
  const [hasImageError, setHasImageError] = useState(false)
  const [manualFallbackUsed, setManualFallbackUsed] = useState(false)
  const prompt = slide?.imagePrompt || `${slide?.title || ""} ${slide?.focus || slide?.studentViewText || ""}`.trim()
  const generatedImageUrl = slide?.imageUrl || (prompt ? buildQuestionImageUrl(prompt, slide?.title || "Presentatie", { kind: "slide" }) : "")
  const manualImageUrl = slide?.manualImageUrl || ""
  const imageUrl = manualImageUrl && !manualFallbackUsed ? manualImageUrl : generatedImageUrl

  useEffect(() => {
    setHasImageError(false)
    setManualFallbackUsed(false)
  }, [slide?.id, slide?.manualImageUrl])

  if (!prompt || hasImageError) {
    return (
      <div className={`slide-visual-fallback ${compact ? "compact" : ""}`}>
        <span className="visual-label">Dia</span>
        <strong>{slide?.title || "Presentatiedia"}</strong>
        <p>{slide?.focus || slide?.studentViewText || "De kern van deze uitleg verschijnt hier."}</p>
      </div>
    )
  }

  return (
    <img
      alt={slide?.imageAlt || slide?.title || "Presentatiedia"}
      className={`slide-visual ${compact ? "compact" : ""}`}
      onError={() => {
        if (manualImageUrl && !manualFallbackUsed) {
          setManualFallbackUsed(true)
          return
        }
        setHasImageError(true)
      }}
      src={imageUrl}
    />
  )
}

function ManualSlideImageCard({
  slide,
  imageUrl,
  altText,
  uploadName,
  hasManualImage,
  isBusy = false,
  onAutoSearch,
  onImageUrlChange,
  onAltTextChange,
  onSaveUrl,
  onUpload,
  onClear,
}) {
  if (!slide) return null

  return (
    <section className="glass board-card manual-image-card">
      <div className="section-head">
        <h2>Dia-afbeelding</h2>
        <span className="pill">{slide.title}</span>
      </div>
      <p className="muted">
        Laat de site eerst zelf een passende internetafbeelding zoeken. Lukt dat niet goed, dan kun je nog steeds zelf een directe afbeeldingslink plakken of een bestand uploaden.
      </p>
      <div className="field-row manual-image-grid">
        <label className="field">
          <span>Afbeeldingslink</span>
          <input
            onChange={(event) => onImageUrlChange(event.target.value)}
            placeholder="https://voorbeeld.nl/afbeelding.jpg"
            value={imageUrl}
          />
        </label>
        <label className="field">
          <span>Alt-tekst</span>
          <input
            onChange={(event) => onAltTextChange(event.target.value)}
            placeholder="Korte beschrijving van de afbeelding"
            value={altText}
          />
        </label>
      </div>
      <div className="manual-image-actions">
        <button className="button-primary" disabled={isBusy} onClick={onAutoSearch} type="button">
          {isBusy ? "Bezig..." : "Zoek automatisch online"}
        </button>
        <button className="button-secondary" disabled={isBusy || !imageUrl.trim()} onClick={onSaveUrl} type="button">
          Gebruik link
        </button>
        <label className={`button-ghost manual-upload-button ${isBusy ? "is-disabled" : ""}`}>
          {isBusy ? "Bezig..." : "Upload afbeelding"}
          <input
            accept="image/*"
            disabled={isBusy}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onUpload(file)
              event.target.value = ""
            }}
            type="file"
          />
        </label>
        <button className="button-ghost subtle-danger" disabled={isBusy || !hasManualImage} onClick={onClear} type="button">
          Wis handmatige afbeelding
        </button>
      </div>
      <div className="manual-image-meta">
        <span>{hasManualImage ? "Handmatige afbeelding actief" : "Automatisch beeld actief"}</span>
        {uploadName ? <strong>{uploadName}</strong> : null}
      </div>
      {slide.manualImageSearchQuery || slide.manualImageSourceTitle || slide.manualImageSourceUrl ? (
        <div className="manual-image-source">
          {slide.manualImageSearchQuery ? <span>Zoekterm: {slide.manualImageSearchQuery}</span> : null}
          {slide.manualImageSourceTitle ? <strong>Bron: {slide.manualImageSourceTitle}</strong> : null}
          {slide.manualImageSourceUrl ? (
            <a href={slide.manualImageSourceUrl} rel="noreferrer" target="_blank">
              Open bron
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function PresentationSlideCanvas({ presentation, slide, compact = false, variant = "default" }) {
  if (!slide) return null
  const stackedLayout = compact || variant === "preview" || variant === "student"

  return (
    <article
      className={`presentation-slide-canvas ${compact ? "compact" : ""} ${stackedLayout ? "is-stacked" : ""} ${variant === "board" ? "is-board" : ""}`}
    >
      <div className="presentation-slide-copy">
        <span className="eyebrow">{presentation?.title || "Presentatieweergave"}</span>
        <h4>{slide.title}</h4>
        <p>{slide.studentViewText || slide.focus}</p>
        {(slide.bullets || []).length ? (
          <ul className="presentation-bullet-list">
            {slide.bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="presentation-slide-visual-wrap">
        <SlideVisual compact={compact} slide={slide} />
      </div>
    </article>
  )
}

function LessonPresentationPanel({ presentation, compact = false, interactive = false, onOpen = null }) {
  if (!presentation?.currentSlide) return null
  const hasVideo = !compact && Boolean(presentation.video)
  const canvas = (
    <PresentationSlideCanvas
      compact={compact}
      presentation={presentation}
      slide={presentation.currentSlide}
      variant={compact ? "student" : interactive ? "preview" : "default"}
    />
  )

  return (
    <section className={`lesson-presentation-panel ${compact ? "compact" : ""} ${interactive ? "is-interactive" : ""}`}>
      <div className="section-head">
        <h3>{compact ? "Live dia" : "Presentatieweergave"}</h3>
        <div className="presentation-panel-actions">
          <span className="pill">
            {presentation.slideCount ? `${presentation.slideCount} dia's` : presentation.style || "Interactief"}
          </span>
          {interactive && onOpen ? (
            <button className="button-ghost presentation-open-button" onClick={onOpen} type="button">
              Open op digibord
            </button>
          ) : null}
        </div>
      </div>
      <div className={`presentation-stage ${compact ? "compact" : ""} ${hasVideo ? "has-video" : "is-single"}`}>
        {interactive && onOpen ? (
          <button
            aria-label="Open presentatieweergave op digibord"
            className="presentation-preview-button"
            onClick={onOpen}
            type="button"
          >
            {canvas}
          </button>
        ) : (
          canvas
        )}
        {hasVideo ? (
          <div className="presentation-video-card">
            <span className="eyebrow">Video-opzet</span>
            <h4>{presentation.video.title}</h4>
            <p>{presentation.video.summary}</p>
            {presentation.video.currentScene ? (
              <div className="micro-slide">
                <b>{presentation.video.currentScene.title}</b>
                <p>{presentation.video.currentScene.narration}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function LessonPresenterOverlay({ lesson, insights, onPrevious, onNext, onClose }) {
  if (!lesson?.presentation?.currentSlide || !lesson?.currentPhase) return null

  const slide = lesson.presentation.currentSlide
  const videoScene = lesson.presentation.video?.currentScene || null
  const answeredCount = insights?.answeredCount ?? 0
  const totalPlayers = insights?.totalPlayers ?? 0
  const canGoBack = lesson.currentPhaseIndex > 0

  return (
    <div className="presenter-overlay">
      <button aria-label="Sluit presentatieweergave" className="presenter-backdrop" onClick={onClose} type="button" />
      <section className="presenter-stage-frame">
        <div className="presenter-topbar">
          <div>
            <span className="eyebrow">{lesson.presentation.title}</span>
            <h2>{slide.title}</h2>
          </div>
          <div className="presenter-pills">
            <span className="pill">{lesson.currentPhaseIndex + 1} / {lesson.totalPhases}</span>
            <span className="pill">{lesson.currentPhase.minutes} min</span>
          </div>
        </div>

        <div className="presenter-main">
          <article className="presenter-slide-card">
            <span className="presenter-kicker">{lesson.currentPhase.title}</span>
            <PresentationSlideCanvas presentation={lesson.presentation} slide={slide} variant="board" />
          </article>
        </div>

        <aside className="presenter-support-grid">
          <div className="presenter-side-card">
            <span className="presenter-kicker">Live opdracht</span>
            <p>{lesson.currentPhase.prompt || lesson.currentPhase.goal}</p>
          </div>

          {videoScene ? (
            <div className="presenter-side-card video-card">
              <span className="presenter-kicker">Video-opzet</span>
              <strong>{videoScene.title}</strong>
              <p>{videoScene.narration}</p>
            </div>
          ) : null}

          <div className="presenter-side-card">
            <span className="presenter-kicker">Klasreacties</span>
            <strong>{answeredCount}/{totalPlayers}</strong>
            <p>
              {insights?.allAnswered
                ? "Iedereen heeft gereageerd. Je kunt nu door."
                : "Reacties lopen nog binnen."}
            </p>
          </div>
        </aside>

        <div className="presenter-bottombar">
          <span className="presenter-hint">ESC of klik buiten de kaart om de presentatieweergave te sluiten</span>
          <div className="presenter-actions">
            <button className="button-ghost" onClick={onClose} type="button">
              Sluit presentatieweergave
            </button>
            <button className="button-ghost" disabled={!canGoBack} onClick={onPrevious} type="button">
              Vorige lesstap
            </button>
            <button className="button-secondary" onClick={onNext} type="button">
              Volgende lesstap
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

function BattlePresenterOverlay({ game, insights, timeLeft, onClose, onStart, onReveal, onNext, canReveal = false }) {
  if (!game?.question) return null

  const showCorrectAnswer = game.status === "revealed"
  const answeredCount = insights?.answeredCount ?? 0
  const totalPlayers = insights?.totalPlayers ?? 0
  const answerWindowExpired = game.status === "live" && (timeLeft === 0 || Boolean(insights?.answerWindowExpired))
  const liveHint = showCorrectAnswer
    ? "Het juiste antwoord is nu zichtbaar op het digibord."
    : insights?.allAnswered
      ? "Iedereen heeft geantwoord. Het juiste antwoord kan nu veilig getoond worden."
      : answerWindowExpired
        ? "De tijd is voorbij. Het juiste antwoord mag nu getoond worden."
        : "Je ziet hier alleen de vraag en antwoordopties. Het juiste antwoord blijft nog verborgen."

  return (
    <div className="presenter-overlay battle-presenter-overlay">
      <button aria-label="Sluit digibordweergave" className="presenter-backdrop" onClick={onClose} type="button" />
      <section className="presenter-stage-frame battle-presenter-stage">
        <div className="presenter-topbar">
          <div>
            <span className="eyebrow">Battle op het digibord</span>
            <h2>Vraag op het digibord</h2>
          </div>
          <div className="presenter-pills">
            <span className="pill">
              {game.status === "preview"
                ? `Preview ${game.currentQuestionIndex + 1} / ${game.totalQuestions}`
                : game.status === "revealed"
                  ? `Antwoord ${game.currentQuestionIndex + 1} / ${game.totalQuestions}`
                  : `Vraag ${game.currentQuestionIndex + 1} / ${game.totalQuestions}`}
            </span>
            <span className="pill">{game.status === "live" ? `${timeLeft}s` : game.status === "revealed" ? "Antwoord" : "Klaar"}</span>
            <span className="pill">{answeredCount}/{totalPlayers} geantwoord</span>
          </div>
        </div>

        <div className="presenter-main battle-presenter-main">
          <article className="presenter-slide-card battle-question-stage">
            <QuestionCard question={game.question} revealCorrect={showCorrectAnswer} />
          </article>
        </div>

        <div className="presenter-bottombar">
          <span className="presenter-hint">{liveHint}</span>
          <div className="presenter-actions">
            {game.status === "preview" ? (
              <button className="button-secondary" onClick={onStart} type="button">
                Start vraag
              </button>
            ) : null}
            {game.status === "live" ? (
              <button className="button-secondary" disabled={!canReveal} onClick={onReveal} type="button">
                Toon antwoord
              </button>
            ) : null}
            {game.status === "revealed" ? (
              <button className="button-secondary" onClick={onNext} type="button">
                Volgende vraag
              </button>
            ) : null}
            <button className="button-ghost" onClick={onClose} type="button">
              Sluit digibordweergave
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

function LessonPromptComposer({
  text,
  expectedAnswer,
  onTextChange,
  onExpectedAnswerChange,
  onSubmit,
}) {
  return (
    <section className="lesson-prompt-composer">
      <div className="section-head">
        <h3>Live lesvraag</h3>
        <span className="pill">Open vraag</span>
      </div>
      <label className="field">
        <span>Vraag of opdracht voor leerlingen</span>
        <textarea
          rows="3"
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder="Typ hier de vraag die nu live naar de leerlingen moet."
        />
      </label>
      <label className="field">
        <span>Verwacht antwoord</span>
        <textarea
          rows="2"
          value={expectedAnswer}
          onChange={(event) => onExpectedAnswerChange(event.target.value)}
          placeholder="Korte kern van een goed antwoord."
        />
      </label>
      <button className="button-secondary" disabled={!text.trim()} onClick={onSubmit} type="button">
        Toon vraag live
      </button>
    </section>
  )
}

function BattleQuestionControls({
  status,
  duration,
  onDurationChange,
  onStart,
  onReveal,
  questionMultiplier,
  finalSprintActive,
  canReveal = false,
  answeredCount = 0,
  totalPlayers = 0,
  answerWindowExpired = false,
}) {
  const durationPresets = [10, 20, 30, 45, 60]

  return (
    <section className="lesson-response-panel battle-preview-panel">
      <div className="section-head">
        <h3>{status === "preview" ? "Docent preview" : status === "revealed" ? "Antwoord getoond" : "Vraag loopt live"}</h3>
        <span className="pill">
          {status === "preview"
            ? "Bekijk de vraag en start daarna"
            : status === "revealed"
              ? "Het antwoord is zichtbaar voor leerlingen"
              : "De klas antwoordt nu"}
        </span>
      </div>

      <div className={`question-points-panel ${finalSprintActive ? "is-final-sprint" : ""}`}>
        <strong>{questionMultiplier > 1 ? `Deze vraag telt x${questionMultiplier}` : "Normale vraagpunten"}</strong>
        <span>
          {questionMultiplier > 1
            ? "Basispunten en snelheidsbonus worden op deze vraag verdubbeld."
            : "Goed antwoord = 100 punten. Sneller antwoorden geeft extra bonuspunten."}
        </span>
      </div>

      {status === "preview" ? (
        <>
          <div className="duration-preset-row">
            {durationPresets.map((preset) => (
              <button
                key={preset}
                className={`button-ghost duration-chip ${Number(duration) === preset ? "is-active" : ""}`}
                onClick={() => onDurationChange(preset)}
                type="button"
              >
                {preset}s
              </button>
            ))}
          </div>
          <label className="field inline-field">
            <span>Tijd voor deze vraag (sec)</span>
            <input
              type="number"
              min="5"
              max="180"
              value={duration}
              onChange={(event) => onDurationChange(Number(event.target.value))}
            />
          </label>
          <button className="button-primary" onClick={onStart} type="button">
            Start vraag
          </button>
        </>
      ) : status === "live" ? (
        <div className="battle-preview-actions">
          <p>
            {canReveal
              ? answerWindowExpired
                ? "De tijd is voorbij. Je kunt nu het juiste antwoord tonen."
                : "Iedereen heeft geantwoord. Je kunt nu het juiste antwoord tonen."
              : `${answeredCount}/${totalPlayers} leerlingen hebben geantwoord. Het juiste antwoord blijft verborgen tot iedereen klaar is of de tijd voorbij is.`}
          </p>
          <button className="button-secondary" disabled={!canReveal} onClick={onReveal} type="button">
            Toon antwoord
          </button>
        </div>
      ) : (
        <div className="battle-preview-actions">
          <p>Het antwoord is getoond. Bespreek de vraag en ga daarna door naar de volgende previewvraag.</p>
        </div>
      )}
    </section>
  )
}

function LessonResponsePanel({ answer, onChange, onSubmit, prompt = "", result, disabled }) {
  return (
    <section className="lesson-response-panel">
      <div className="section-head">
        <h3>Jouw antwoord</h3>
        <span className="pill">{result?.label || "Nog niet verstuurd"}</span>
      </div>

      {prompt ? (
        <div className="lesson-response-callout">
          <strong>Vraag in deze dia</strong>
          <p>{prompt}</p>
        </div>
      ) : null}

      <label className="field">
        <span>Typ je reactie</span>
        <textarea
          rows="4"
          value={answer}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Schrijf hier je antwoord of uitleg..."
        />
      </label>

      <button
        className="button-primary"
        disabled={disabled || !answer.trim()}
        onClick={onSubmit}
        type="button"
      >
        Verstuur antwoord
      </button>

      {result ? (
        <div className={`answer-result ${result.isCorrect ? "ok" : "bad"}`}>
          <strong>{result.label}</strong>
          <p>{result.feedback}</p>
        </div>
      ) : null}
    </section>
  )
}

function LessonCompleteCard({ lesson }) {
  return (
    <div className="results-card">
      <span className="eyebrow">Les afgerond</span>
      <h3>{lesson?.title || "De les is afgerond"}</h3>
      <p>{lesson?.lessonGoal || "De sessie is afgerond. Je kunt een nieuwe les of battle starten."}</p>
      {lesson?.successCriteria?.length ? (
        <div className="lesson-box">
          <strong>Afsluiten met deze check</strong>
          <ul>
            {lesson.successCriteria.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function PracticeCompleteCard() {
  return (
    <div className="results-card">
      <span className="eyebrow">Oefentoets afgerond</span>
      <h3>Einde van de oefentoets</h3>
      <p>Je hebt alle oefenvragen doorlopen. Bespreek de antwoorden nu samen met de docent.</p>
    </div>
  )
}

function LessonLibrarySection({
  lessons,
  activeLessonId,
  onLoad,
  onDelete,
  onFavoriteToggle,
  onExportCsv,
  searchValue,
  onSearchChange,
  audienceFilter,
  onAudienceFilterChange,
  availableAudiences,
  sectionFilter,
  onSectionFilterChange,
  availableSections,
  folderFilter,
  onFolderFilterChange,
  availableFolders,
  metaDrafts,
  onMetaDraftChange,
  onMetaSave,
  totalCount,
}) {
  return (
    <section className="glass board-card lesson-library-section">
      <div className="section-head">
        <h2>Lesbibliotheek</h2>
        <span className="pill">
          {lessons.length} van {totalCount} zichtbaar
        </span>
      </div>
      <div className="management-toolbar">
        <label className="field management-search-field">
          <span>Zoek les</span>
          <input
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Zoek op titel, onderwerp, doel of doelgroep"
            value={searchValue}
          />
        </label>
        <div className="management-filter-group">
          <button
            className={`management-filter-chip ${audienceFilter === "all" ? "is-active" : ""}`}
            onClick={() => onAudienceFilterChange("all")}
            type="button"
          >
            Alle doelgroepen
          </button>
          {availableAudiences.map((audience) => (
            <button
              className={`management-filter-chip ${audienceFilter === audience ? "is-active" : ""}`}
              key={audience}
              onClick={() => onAudienceFilterChange(audience)}
              type="button"
            >
              {audience}
            </button>
          ))}
        </div>
        <div className="management-filter-group">
          <button
            className={`management-filter-chip ${sectionFilter === "all" ? "is-active" : ""}`}
            onClick={() => onSectionFilterChange("all")}
            type="button"
          >
            Alle secties
          </button>
          {availableSections.map((section) => (
            <button
              className={`management-filter-chip ${sectionFilter === section ? "is-active" : ""}`}
              key={section}
              onClick={() => onSectionFilterChange(section)}
              type="button"
            >
              {section}
            </button>
          ))}
        </div>
        <div className="management-filter-group">
          <button
            className={`management-filter-chip ${folderFilter === "all" ? "is-active" : ""}`}
            onClick={() => onFolderFilterChange("all")}
            type="button"
          >
            Alle mappen
          </button>
          {availableFolders.map((folder) => (
            <button
              className={`management-filter-chip ${folderFilter === folder ? "is-active" : ""}`}
              key={folder}
              onClick={() => onFolderFilterChange(folder)}
              type="button"
            >
              {folder}
            </button>
          ))}
        </div>
        <div className="management-toolbar-actions">
          <button className="button-ghost" onClick={onExportCsv} type="button">
            Exporteer bibliotheek CSV
          </button>
        </div>
      </div>

      {lessons.length ? (
        <div className="lesson-library-grid">
          {lessons.map((lesson) => (
            <article
              className={`lesson-library-card ${lesson.id === activeLessonId ? "is-active" : ""} ${lesson.isFavorite ? "is-favorite" : ""}`}
              key={lesson.id}
            >
              {(() => {
                const draft = metaDrafts?.[lesson.id] || {
                  folderName: lesson.folderName || "",
                  sectionName: lesson.sectionName || "",
                  tags: Array.isArray(lesson.tags) ? lesson.tags.join(", ") : "",
                }
                return (
                  <>
              <div className="lesson-library-head">
                <div>
                  <span className="eyebrow">{lesson.model}</span>
                  <h3>{lesson.title}</h3>
                </div>
                <span className="pill">{lesson.durationMinutes} min</span>
              </div>
              <p>{lesson.lessonGoal}</p>
              <div className="lesson-library-meta">
                {lesson.isFavorite ? <span>Favoriet</span> : null}
                {lesson.sectionName ? <span>{lesson.sectionName}</span> : null}
                {lesson.ownerDisplayName ? <span>Door {lesson.ownerDisplayName}</span> : null}
                {lesson.folderName ? <span>{lesson.folderName}</span> : null}
                <span>{lesson.topic || "Algemeen thema"}</span>
                <span>{lesson.audience}</span>
                <span>{lesson.phaseCount} fasen</span>
                {lesson.practiceQuestionCount ? <span>{lesson.practiceQuestionCount} oefenvragen</span> : null}
                {lesson.slideCount ? <span>{lesson.slideCount} dia's</span> : null}
                {(lesson.tags || []).map((tag) => (
                  <span key={`${lesson.id}-${tag}`}>#{tag}</span>
                ))}
              </div>
              <div className="lesson-library-edit-grid">
                <label className="field inline-field">
                  <span>Sectie</span>
                  <input
                    onChange={(event) =>
                      onMetaDraftChange(lesson.id, (current) => ({ ...current, sectionName: event.target.value }))
                    }
                    placeholder="Bijv. Rekenen of Mens & maatschappij"
                    value={draft.sectionName}
                  />
                </label>
                <label className="field inline-field">
                  <span>Map</span>
                  <input
                    onChange={(event) =>
                      onMetaDraftChange(lesson.id, (current) => ({ ...current, folderName: event.target.value }))
                    }
                    placeholder="Bijv. VMBO leerjaar 3"
                    value={draft.folderName}
                  />
                </label>
                <label className="field inline-field">
                  <span>Tags</span>
                  <input
                    onChange={(event) =>
                      onMetaDraftChange(lesson.id, (current) => ({ ...current, tags: event.target.value }))
                    }
                    placeholder="Bijv. economie, korting, vmbo"
                    value={draft.tags}
                  />
                </label>
              </div>
              <div className="lesson-library-actions">
                <button className="button-ghost" onClick={() => onFavoriteToggle(lesson.id, !lesson.isFavorite)} type="button">
                  {lesson.isFavorite ? "Favoriet verwijderen" : "Markeer als favoriet"}
                </button>
                <button className="button-ghost" onClick={() => onMetaSave(lesson.id)} type="button">
                  Sla sectie, map en tags op
                </button>
                <button className="button-secondary" onClick={() => onLoad(lesson.id)} type="button">
                  Open les
                </button>
                <button className="button-ghost" onClick={() => onDelete(lesson.id)} type="button">
                  Verwijder
                </button>
              </div>
                  </>
                )
              })()}
            </article>
          ))}
        </div>
      ) : totalCount ? (
        <div className="empty-state compact-empty">
          <h3>Geen les gevonden</h3>
          <p>Pas je zoekterm of doelgroepfilter aan om een opgeslagen les terug te vinden.</p>
        </div>
      ) : (
        <div className="empty-state compact-empty">
          <h3>Nog geen lessen opgeslagen</h3>
          <p>Genereer eerst een les in Lesmodus en sla die daarna op in de bibliotheek.</p>
        </div>
      )}
    </section>
  )
}

function ClassesSection({
  audienceFilter,
  availableAudiences,
  classroomImportBusyId,
  classrooms,
  newClassroomForm,
  onAudienceFilterChange,
  onCreateClassroom,
  onClassroomImport,
  onExportCsv,
  onNewClassroomChange,
  onSearchChange,
  classroomDrafts,
  onClassroomDraftChange,
  onClassroomSave,
  onClassroomDelete,
  classroomLearnerDrafts,
  onClassroomLearnerDraftChange,
  onClassroomLearnerAdd,
  classroomLearnerEditDrafts,
  onClassroomLearnerEditChange,
  onClassroomLearnerSave,
  onClassroomLearnerDelete,
  searchValue,
  selectedMathClassId,
  onSelectForMath,
  totalCount,
}) {
  return (
    <section className="glass board-card lesson-library-section">
      <div className="section-head">
        <h2>Klassen</h2>
        <span className="pill">
          {classrooms.length} zichtbaar{typeof totalCount === "number" ? ` van ${totalCount}` : ""}
        </span>
      </div>

      <div className="management-toolbar classes-toolbar">
        <label className="field inline-field">
          <span>Zoek klas of leerling</span>
          <input
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Bijv. 3KB, Amina of 4821"
            value={searchValue}
          />
        </label>
        <label className="field inline-field">
          <span>Doelgroep</span>
          <select onChange={(event) => onAudienceFilterChange(event.target.value)} value={audienceFilter}>
            <option value="all">Alle doelgroepen</option>
            {availableAudiences.map((audience) => (
              <option key={audience} value={audience}>
                {audience}
              </option>
            ))}
          </select>
        </label>
        <div className="management-toolbar-actions">
          <button className="button-ghost" onClick={onExportCsv} type="button">
            Exporteer CSV
          </button>
        </div>
      </div>

      <div className="management-toolbar classes-toolbar">
        <label className="field inline-field">
          <span>Nieuwe klas</span>
          <input
            onChange={(event) => onNewClassroomChange((current) => ({ ...current, name: event.target.value }))}
            placeholder="Bijv. 3KB of Brugklas A"
            value={newClassroomForm.name}
          />
        </label>
        <label className="field inline-field">
          <span>Sectie</span>
          <input
            onChange={(event) => onNewClassroomChange((current) => ({ ...current, sectionName: event.target.value }))}
            placeholder="Bijv. Rekenen"
            value={newClassroomForm.sectionName}
          />
        </label>
        <label className="field inline-field">
          <span>Doelgroep</span>
          <select
            onChange={(event) => onNewClassroomChange((current) => ({ ...current, audience: event.target.value }))}
            value={newClassroomForm.audience}
          >
            <option value="vmbo">VMBO</option>
            <option value="brugklas">Brugklas</option>
            <option value="mavo/havo">Mavo/Havo</option>
            <option value="mbo">MBO</option>
            <option value="algemeen">Algemeen</option>
          </select>
        </label>
        <div className="management-toolbar-actions">
          <button className="button-secondary" onClick={onCreateClassroom} type="button">
            Voeg klas toe
          </button>
        </div>
      </div>

      <p className="math-task-preview">Import ondersteunt Excel en CSV met kolommen zoals naam, leerlingcode en leerlingnummer.</p>

      {classrooms.length ? (
        <div className="lesson-library-grid">
          {classrooms.map((classroom) => {
            const classroomDraft = classroomDrafts[classroom.id] || {
              name: classroom.name,
              sectionName: classroom.sectionName,
              audience: classroom.audience,
            }
            const learnerDraft = classroomLearnerDrafts[classroom.id] || { name: "", learnerCode: "", studentNumber: "" }
            return (
              <article className="lesson-library-card classroom-card" key={classroom.id}>
                <div className="lesson-library-head">
                  <div>
                    <span className="eyebrow">{classroom.sectionName}</span>
                    <h3>{classroom.name}</h3>
                  </div>
                  <span className="pill">{classroom.learnerCount} leerlingen</span>
                </div>
                <div className="lesson-library-meta">
                  <span>{classroom.audience}</span>
                  <span>Door {classroom.ownerDisplayName}</span>
                  {selectedMathClassId === classroom.id ? <span>Nu gekozen voor rekenen</span> : null}
                </div>

                <div className="lesson-library-edit-grid">
                  <label className="field inline-field">
                    <span>Naam</span>
                    <input
                      onChange={(event) =>
                        onClassroomDraftChange(classroom.id, (current) => ({ ...current, name: event.target.value }))
                      }
                      value={classroomDraft.name}
                    />
                  </label>
                  <label className="field inline-field">
                    <span>Sectie</span>
                    <input
                      onChange={(event) =>
                        onClassroomDraftChange(classroom.id, (current) => ({ ...current, sectionName: event.target.value }))
                      }
                      value={classroomDraft.sectionName}
                    />
                  </label>
                  <label className="field inline-field">
                    <span>Doelgroep</span>
                    <select
                      onChange={(event) =>
                        onClassroomDraftChange(classroom.id, (current) => ({ ...current, audience: event.target.value }))
                      }
                      value={classroomDraft.audience}
                    >
                      <option value="vmbo">VMBO</option>
                      <option value="brugklas">Brugklas</option>
                      <option value="mavo/havo">Mavo/Havo</option>
                      <option value="mbo">MBO</option>
                      <option value="algemeen">Algemeen</option>
                    </select>
                  </label>
                </div>

                <div className="lesson-library-actions">
                  <button className="button-secondary" onClick={() => onSelectForMath(classroom.id)} type="button">
                    {selectedMathClassId === classroom.id ? "Gekozen voor rekenen" : "Gebruik voor rekenen"}
                  </button>
                  <button className="button-ghost" onClick={() => onClassroomSave(classroom.id)} type="button">
                    Bewaar klas
                  </button>
                  <button className="button-ghost" onClick={() => onClassroomDelete(classroom.id)} type="button">
                    Verwijder klas
                  </button>
                </div>

                <div className="math-host-card">
                  <div className="math-host-card-head">
                    <div>
                      <strong>Leerlingen in deze klas</strong>
                      <span>Leerlingen kunnen met hun naam en leerlingcode later verdergaan. Je kunt ook een Excel- of CSV-lijst importeren.</span>
                    </div>
                    <label className={`button-ghost classroom-import-button ${classroomImportBusyId === classroom.id ? "is-busy" : ""}`}>
                      {classroomImportBusyId === classroom.id ? "Importeren..." : "Importeer Excel / CSV"}
                      <input
                        accept=".xlsx,.xls,.csv,.txt"
                        onChange={(event) => {
                          const file = event.target.files?.[0]
                          if (file) onClassroomImport(classroom.id, file)
                          event.target.value = ""
                        }}
                        type="file"
                      />
                    </label>
                  </div>
                  <div className="math-create-row">
                    <input
                      className="math-code-input"
                      onChange={(event) =>
                        onClassroomLearnerDraftChange(classroom.id, (current) => ({ ...current, name: event.target.value }))
                      }
                      placeholder="Naam leerling"
                      value={learnerDraft.name}
                    />
                    <input
                      className="math-code-input"
                      inputMode="numeric"
                      maxLength={4}
                      onChange={(event) =>
                        onClassroomLearnerDraftChange(classroom.id, (current) => ({
                          ...current,
                          learnerCode: event.target.value.replace(/\D/g, "").slice(0, 4),
                        }))
                      }
                      placeholder="4 cijfers (optioneel)"
                      value={learnerDraft.learnerCode}
                    />
                    <input
                      className="math-code-input"
                      onChange={(event) =>
                        onClassroomLearnerDraftChange(classroom.id, (current) => ({
                          ...current,
                          studentNumber: event.target.value.replace(/\s+/g, "").slice(0, 12),
                        }))
                      }
                      placeholder="Leerlingnummer (optioneel)"
                      value={learnerDraft.studentNumber}
                    />
                    <button className="button-primary" onClick={() => onClassroomLearnerAdd(classroom.id)} type="button">
                      Voeg leerling toe
                    </button>
                  </div>
                  <p className="math-task-preview">Laat leerlingcode of leerlingnummer leeg als Lesson Battle die automatisch mag maken.</p>

                  <div className="classroom-learner-list">
                    {(classroom.learners || []).map((learner) => {
                      const learnerEditDraft = classroomLearnerEditDrafts[learner.id] || {
                        name: learner.name,
                        learnerCode: learner.learnerCode,
                        studentNumber: learner.studentNumber,
                      }
                      return (
                        <div className="classroom-learner-row" key={learner.id}>
                          <input
                            className="math-code-input"
                            onChange={(event) =>
                              onClassroomLearnerEditChange(learner.id, (current) => ({ ...current, name: event.target.value }))
                            }
                            value={learnerEditDraft.name}
                          />
                          <input
                            className="math-code-input"
                            inputMode="numeric"
                            maxLength={4}
                            onChange={(event) =>
                              onClassroomLearnerEditChange(learner.id, (current) => ({
                                ...current,
                                learnerCode: event.target.value.replace(/\D/g, "").slice(0, 4),
                              }))
                            }
                            value={learnerEditDraft.learnerCode}
                          />
                          <input
                            className="math-code-input"
                            onChange={(event) =>
                              onClassroomLearnerEditChange(learner.id, (current) => ({
                                ...current,
                                studentNumber: event.target.value.replace(/\s+/g, "").slice(0, 12),
                              }))
                            }
                            placeholder="Leerlingnummer"
                            value={learnerEditDraft.studentNumber}
                          />
                          <button className="button-ghost" onClick={() => onClassroomLearnerSave(classroom.id, learner.id)} type="button">
                            Bewaar
                          </button>
                          <button className="button-ghost" onClick={() => onClassroomLearnerDelete(classroom.id, learner.id)} type="button">
                            Verwijder
                          </button>
                        </div>
                      )
                    })}
                    {!classroom.learners?.length ? <p className="math-task-preview">Nog geen leerlingen in deze klas.</p> : null}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      ) : totalCount ? (
        <div className="empty-state compact-empty">
          <h3>Geen klassen gevonden</h3>
          <p>Pas je zoekterm of doelgroepfilter aan om de juiste klas of leerling terug te vinden.</p>
        </div>
      ) : (
        <div className="empty-state compact-empty">
          <h3>Nog geen klassen</h3>
          <p>Maak eerst een klas aan, voeg daarna leerlingen met hun 4-cijferige code toe en gebruik die klas vervolgens voor rekenen.</p>
        </div>
      )}
    </section>
  )
}

function SessionHistorySection({
  entries,
  onLoad,
  onDelete,
  onExportCsv,
  searchValue,
  onSearchChange,
  typeFilter,
  onTypeFilterChange,
  categoryFilter,
  onCategoryFilterChange,
  historyCategories,
  totalCount,
}) {
  return (
    <section className="glass board-card lesson-library-section session-history-section">
      <div className="section-head">
        <h2>Sessiegeschiedenis</h2>
        <span className="pill">
          {entries.length} van {totalCount} zichtbaar
        </span>
      </div>
      <div className="management-toolbar">
        <label className="field management-search-field">
          <span>Zoek sessie</span>
          <input
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Zoek op titel, onderwerp, categorie of doelgroep"
            value={searchValue}
          />
        </label>
        <div className="management-filter-group">
          <button
            className={`management-filter-chip ${typeFilter === "all" ? "is-active" : ""}`}
            onClick={() => onTypeFilterChange("all")}
            type="button"
          >
            Alles
          </button>
          <button
            className={`management-filter-chip ${typeFilter === "lesson" ? "is-active" : ""}`}
            onClick={() => onTypeFilterChange("lesson")}
            type="button"
          >
            Les
          </button>
          <button
            className={`management-filter-chip ${typeFilter === "practice" ? "is-active" : ""}`}
            onClick={() => onTypeFilterChange("practice")}
            type="button"
          >
            Oefentoets
          </button>
          <button
            className={`management-filter-chip ${typeFilter === "battle" ? "is-active" : ""}`}
            onClick={() => onTypeFilterChange("battle")}
            type="button"
          >
            Battle
          </button>
        </div>
        <div className="management-filter-group">
          <button
            className={`management-filter-chip ${categoryFilter === "all" ? "is-active" : ""}`}
            onClick={() => onCategoryFilterChange("all")}
            type="button"
          >
            Alle thema's
          </button>
          {historyCategories.map((category) => (
            <button
              className={`management-filter-chip ${categoryFilter === category ? "is-active" : ""}`}
              key={category}
              onClick={() => onCategoryFilterChange(category)}
              type="button"
            >
              {category}
            </button>
          ))}
        </div>
        <div className="management-toolbar-actions">
          <button className="button-ghost" onClick={onExportCsv} type="button">
            Exporteer geschiedenis CSV
          </button>
        </div>
      </div>

      {entries.length ? (
        <div className="lesson-library-grid">
          {entries.map((entry) => (
            <article className="lesson-library-card session-history-card" key={entry.id}>
              <div className="lesson-library-head">
                <div>
                  <div className="history-chip-row">
                    <span className="eyebrow">{entry.type === "lesson" ? "Les" : entry.type === "practice" ? "Oefentoets" : "Quiz"}</span>
                    <span className="history-category-chip">{entry.category}</span>
                  </div>
                  <h3>{entry.title}</h3>
                </div>
                <span className="pill">{formatHistoryDate(entry.updatedAt)}</span>
              </div>
              <p>{entry.lessonGoal || entry.topic || "Opgeslagen sessie"}</p>
              <div className="lesson-library-meta">
                <span>{entry.topic || "Algemeen thema"}</span>
                <span>{entry.audience}</span>
                {entry.questionCount ? <span>{entry.questionCount} vragen</span> : null}
                {entry.phaseCount ? <span>{entry.phaseCount} fasen</span> : null}
                {entry.practiceQuestionCount ? <span>{entry.practiceQuestionCount} oefenvragen</span> : null}
                {entry.slideCount ? <span>{entry.slideCount} dia's</span> : null}
                <span>{entry.providerLabel}</span>
              </div>
              <div className="lesson-library-actions">
                <button className="button-secondary" onClick={() => onLoad(entry.id)} type="button">
                  Opnieuw openen
                </button>
                <button className="button-ghost" onClick={() => onDelete(entry.id)} type="button">
                  Verwijder
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : totalCount ? (
        <div className="empty-state compact-empty">
          <h3>Geen sessie gevonden</h3>
          <p>Probeer een andere zoekterm of zet je filters terug om meer sessies te zien.</p>
        </div>
      ) : (
        <div className="empty-state compact-empty">
          <h3>Nog geen sessies in de geschiedenis</h3>
          <p>Nieuwe lessen, quizzen en oefentoetsen verschijnen hier automatisch en worden direct op onderwerp gegroepeerd.</p>
        </div>
      )}
    </section>
  )
}

function TeacherAccountsSection({
  accounts,
  canAssignManagerRole,
  form,
  onCreate,
  onDelete,
  onDraftPasswordChange,
  onFormChange,
  onUpdate,
  passwordDrafts,
}) {
  return (
    <section className="glass board-card teacher-accounts-section">
      <div className="section-head">
        <h2>Docentaccounts</h2>
        <span className="pill">{accounts.length + 1} totaal incl. hoofdaccount</span>
      </div>

      <div className="teacher-accounts-layout">
        <article className="teacher-account-form-card">
          <span className="eyebrow">Nieuwe collega</span>
          <h3>Voeg een docent toe</h3>
          <p>Geef een collega een eigen login zodat jullie dezelfde omgeving kunnen gebruiken.</p>
          <div className="field-row teacher-form-grid">
            <label className="field">
              <span>Naam</span>
              <input
                value={form.displayName}
                onChange={(event) => onFormChange((current) => ({ ...current, displayName: event.target.value }))}
                placeholder="Bijv. Mevr. Smit"
              />
            </label>
            <label className="field">
              <span>Gebruikersnaam</span>
              <input
                value={form.username}
                onChange={(event) => onFormChange((current) => ({ ...current, username: event.target.value }))}
                placeholder="bijv. m.smit"
              />
            </label>
            <label className="field">
              <span>Wachtwoord</span>
              <input
                type="password"
                value={form.password}
                onChange={(event) => onFormChange((current) => ({ ...current, password: event.target.value }))}
                placeholder="Minimaal 6 tekens"
              />
            </label>
            {canAssignManagerRole ? (
              <label className="field">
                <span>Rol</span>
                <select
                  value={form.role}
                  onChange={(event) => onFormChange((current) => ({ ...current, role: event.target.value }))}
                >
                  <option value="teacher">Docent</option>
                  <option value="manager">Beheerder</option>
                </select>
              </label>
            ) : null}
          </div>
          <button
            className="button-primary"
            disabled={!form.username.trim() || !form.password.trim()}
            onClick={onCreate}
            type="button"
          >
            Account toevoegen
          </button>
        </article>

        <div className="teacher-account-list">
          {accounts.length ? (
            accounts.map((account) => (
              <article className="teacher-account-card" key={account.id}>
                <div className="teacher-account-head">
                  <div>
                    <span className="eyebrow">{account.role === "manager" ? "Beheerder" : "Docent"}</span>
                    <h3>{account.displayName || account.username}</h3>
                  </div>
                  <span className="pill">@{account.username}</span>
                </div>
                <p>Laatst bijgewerkt: {formatHistoryDate(account.updatedAt)}</p>
                <div className="teacher-account-actions">
                  <label className="field inline-field">
                    <span>Nieuw wachtwoord</span>
                    <input
                      type="password"
                      value={passwordDrafts[account.id] || ""}
                      onChange={(event) => onDraftPasswordChange(account.id, event.target.value)}
                      placeholder="Laat leeg als het niet hoeft"
                    />
                  </label>
                  <div className="teacher-account-button-row">
                    <button
                      className="button-secondary"
                      disabled={!passwordDrafts[account.id]?.trim()}
                      onClick={() => onUpdate(account)}
                      type="button"
                    >
                      Wachtwoord opslaan
                    </button>
                    <button className="button-ghost subtle-danger" onClick={() => onDelete(account.id)} type="button">
                      Verwijder
                    </button>
                  </div>
                </div>
              </article>
            ))
          ) : (
            <div className="empty-state compact-empty">
              <h3>Nog geen extra docentaccounts</h3>
              <p>Voeg hier collega’s toe. Het hoofdaccount uit je `.env` blijft gewoon bestaan.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function buildLessonDistribution(responses) {
  const buckets = [
    { key: "goed", label: "Goed", colorClass: "good", match: (response) => response.evaluationLabel === "Goed" },
    { key: "bijna", label: "Bijna goed", colorClass: "almost", match: (response) => response.evaluationLabel === "Bijna" },
    {
      key: "nog-niet",
      label: "Nog niet goed",
      colorClass: "notyet",
      match: (response) => response.evaluationLabel !== "Goed" && response.evaluationLabel !== "Bijna",
    },
  ]

  return buckets.map((bucket) => {
    const players = responses.filter(bucket.match)
    return {
      ...bucket,
      players,
    }
  })
}

function LessonDistributionChart({ responses, totalPlayers }) {
  const distribution = buildLessonDistribution(responses)
  const safeTotal = Math.max(1, totalPlayers || responses.length || 1)

  return (
    <section className="lesson-distribution">
      <div className="section-head">
        <h3>Klasbeeld</h3>
        <span className="pill">Hover voor namen</span>
      </div>
      <div className="distribution-grid">
        {distribution.map((bucket) => {
          const percentage = Math.round((bucket.players.length / safeTotal) * 100)
          return (
            <div className={`distribution-card ${bucket.colorClass}`} key={bucket.key}>
              <div className="distribution-meta">
                <strong>{bucket.label}</strong>
                <span>
                  {bucket.players.length} leerling{bucket.players.length === 1 ? "" : "en"}
                </span>
              </div>
              <div className="distribution-bar-track">
                <div className="distribution-bar-fill" style={{ width: `${percentage}%` }} />
              </div>
              <div className="distribution-stats">
                <b>{percentage}%</b>
                <span>{bucket.players.length}/{safeTotal}</span>
              </div>

              <div className="distribution-tooltip">
                <strong>{bucket.label}</strong>
                {bucket.players.length ? (
                  <ul>
                    {bucket.players.map((player) => (
                      <li key={player.playerId}>
                        <span>{player.name}</span>
                        <b>{player.evaluationLabel || "Nog niet"}</b>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>Geen leerlingen in deze categorie.</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function HostInsightsCard({ insights }) {
  if (!insights) return null
  const unansweredPlayers = insights.unansweredPlayers || []

  if (insights.mode === "lesson") {
    return (
      <section className="teacher-insights">
        <div className="section-head">
          <h3>Reactieoverzicht</h3>
          <span className="pill">
            {insights.answeredCount}/{insights.totalPlayers} gereageerd
          </span>
        </div>

        {insights.allAnswered ? (
          <div className="answer-result ok">
            <strong>Iedereen heeft gereageerd.</strong>
            <p>Je kunt nu bespreken en doorgaan naar de volgende lesstap.</p>
          </div>
        ) : (
          <div className="answer-result">
            <strong>Er komen nog reacties binnen.</strong>
            <p>Wacht op de rest of ga handmatig verder als dat didactisch beter past.</p>
          </div>
        )}

        {insights.expectedAnswer ? (
          <div className="lesson-box">
            <strong>Live vraag</strong>
            <p>{insights.prompt}</p>
          </div>
        ) : null}

        {insights.expectedAnswer ? (
          <div className="lesson-box">
            <strong>Verwacht antwoord</strong>
            <p>{insights.expectedAnswer}</p>
          </div>
        ) : null}

        <LessonDistributionChart responses={insights.responses} totalPlayers={insights.totalPlayers} />

        {unansweredPlayers.length ? (
          <div className="missing-player-panel">
            <div className="section-head">
              <h3>Nog geen reactie</h3>
              <span className="pill">{unansweredPlayers.length}</span>
            </div>
            <div className="missing-player-list">
              {unansweredPlayers.map((player) => (
                <div className={`missing-player-chip ${player.connected === false ? "offline" : ""}`} key={player.playerId}>
                  <strong>{player.name}</strong>
                  <span>{player.connected === false ? "Offline" : player.teamName || "Nog bezig"}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="insight-grid">
          {insights.responses.map((response) => (
            <div
              className={`insight-row ${response.answered ? "answered" : "pending"} ${response.isCorrect ? "correct" : ""}`}
              key={response.playerId}
            >
              <div>
                <strong>{response.name}</strong>
                <span>{response.teamName || "Zonder team"}</span>
                {response.answerText ? <span>{response.answerText}</span> : null}
              </div>
              <div className="insight-answer">
                {response.answered ? (
                  <>
                    <b>{response.evaluationLabel || "Binnen"}</b>
                    <span>{response.feedback || "Reactie ontvangen."}</span>
                  </>
                ) : (
                  <>
                    <span>{response.connected === false ? "Leerling is offline" : "Nog geen reactie binnen"}</span>
                    <b>{response.connected === false ? "Offline" : "Wacht nog"}</b>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    )
  }

  return (
    <section className="teacher-insights">
      <div className="section-head">
        <h3>Antwoordoverzicht</h3>
        <span className="pill">
          {insights.answeredCount}/{insights.totalPlayers} geantwoord
        </span>
      </div>

      <div className={`answer-result ${insights.finalSprintActive ? "boost" : "ok"}`}>
        <strong>Juiste antwoord: {insights.correctOption}</strong>
        <p>{insights.explanation || "De docent kan dit antwoord direct bespreken."}</p>
        <span className="answer-result-meta">
          {insights.questionMultiplier > 1
            ? `Dubbele punten actief. ${insights.leadingTeamName || "De koploper"} stond ${insights.leadingGap} punten voor.`
            : "Scoring: 100 basispunten plus een snelheidsbonus voor snelle antwoorden."}
        </span>
      </div>

      <BattleDistributionChart distribution={insights.distribution || []} totalPlayers={insights.totalPlayers} />

      <div className="answer-result">
        <strong>{insights.allAnswered ? "Iedereen is klaar." : "De vraag loopt nog."}</strong>
        <p>
          {insights.allAnswered
            ? "Je kunt nu het antwoord tonen of doorgaan naar de volgende vraag."
            : "Je ziet de verdeling al live terwijl de rest nog antwoordt."}
        </p>
      </div>

      {unansweredPlayers.length ? (
        <div className="missing-player-panel">
          <div className="section-head">
            <h3>Nog niet geantwoord</h3>
            <span className="pill">{unansweredPlayers.length}</span>
          </div>
          <div className="missing-player-list">
            {unansweredPlayers.map((player) => (
              <div className={`missing-player-chip ${player.connected === false ? "offline" : ""}`} key={player.playerId}>
                <strong>{player.name}</strong>
                <span>{player.connected === false ? "Offline" : player.teamName || "Nog bezig"}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="insight-grid">
        {insights.responses.map((response) => (
          <div
            className={`insight-row ${response.answered ? "answered" : "pending"} ${response.isCorrect ? "correct" : ""}`}
            key={response.playerId}
            >
            <div>
              <strong>{response.name}</strong>
              <span>{response.teamName || "Zonder team"}</span>
            </div>
            <div className="insight-answer">
              {response.answered ? (
                <>
                  <span>{response.answerText || "Geen antwoordtekst"}</span>
                  <b>{response.isCorrect ? `Goed • +${response.awardedPoints}` : "Fout • 0"}</b>
                  {response.isCorrect ? (
                    <span>
                      {response.speedBonus ? `Snelheidsbonus +${response.speedBonus}` : "Goed zonder extra bonus"}
                      {response.multiplier > 1 ? ` • x${response.multiplier}` : ""}
                      {response.elapsedMs >= 0 ? ` • ${formatAnswerSpeed(response.elapsedMs)}` : ""}
                    </span>
                  ) : null}
                </>
              ) : (
                <>
                  <span>{response.connected === false ? "Leerling is offline" : "Nog geen antwoord binnen"}</span>
                  <b>{response.connected === false ? "Offline" : "Wacht nog"}</b>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function BattleDistributionChart({ distribution, totalPlayers }) {
  const safeTotal = Math.max(1, totalPlayers || 1)

  return (
    <section className="lesson-distribution">
      <div className="section-head">
        <h3>Live verdeling</h3>
        <span className="pill">A/B/C/D</span>
      </div>
      <div className="distribution-grid">
        {distribution.map((bucket) => {
          const percentage = Math.round((bucket.count / safeTotal) * 100)
          return (
            <div className="distribution-card battle-distribution-card" key={bucket.index}>
              <div className="distribution-meta">
                <strong>{bucket.key}</strong>
                <span>{bucket.option}</span>
              </div>
              <div className="distribution-bar-track">
                <div className="distribution-bar-fill" style={{ width: `${percentage}%` }} />
              </div>
              <div className="distribution-stats">
                <b>{bucket.count}</b>
                <span>{percentage}%</span>
              </div>

              <div className="distribution-tooltip">
                <strong>Optie {bucket.key}</strong>
                {bucket.players.length ? (
                  <ul>
                    {bucket.players.map((player) => (
                      <li key={player.playerId}>
                        <span>{player.name}</span>
                        <b>{player.teamName || "Zonder team"}</b>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>Nog geen antwoorden op deze optie.</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function useQuestionCountdown(game) {
  const [timeLeft, setTimeLeft] = useState(game.questionDurationSec || 20)

  useEffect(() => {
    if (game.status !== "live" || !game.questionStartedAt) {
      setTimeLeft(game.questionDurationSec || 20)
      return
    }

    const update = () => {
      const endTime = new Date(game.questionStartedAt).getTime() + (game.questionDurationSec || 20) * 1000
      const next = Math.max(0, Math.ceil((endTime - Date.now()) / 1000))
      setTimeLeft(next)
    }

    update()
    const interval = window.setInterval(update, 250)
    return () => window.clearInterval(interval)
  }, [game.question?.id, game.questionDurationSec, game.questionStartedAt, game.status])

  return timeLeft
}

function useSoundEffects(result, status) {
  useEffect(() => {
    if (!result || result.waitingForReveal) return

    playTone(result.correct ? 880 : 240, result.correct ? 0.12 : 0.18, result.correct ? "triangle" : "sawtooth")
  }, [result])

  useEffect(() => {
    if (status !== "finished") return
    playTone(660, 0.12, "triangle")
    window.setTimeout(() => playTone(880, 0.16, "triangle"), 140)
  }, [status])
}

function playTone(frequency, duration, type = "sine") {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext
  if (!AudioContextClass) return

  const context = new AudioContextClass()
  const oscillator = context.createOscillator()
  const gainNode = context.createGain()

  oscillator.type = type
  oscillator.frequency.value = frequency
  gainNode.gain.value = 0.0001
  oscillator.connect(gainNode)
  gainNode.connect(context.destination)

  const now = context.currentTime
  gainNode.gain.exponentialRampToValueAtTime(0.04, now + 0.01)
  gainNode.gain.exponentialRampToValueAtTime(0.0001, now + duration)
  oscillator.start(now)
  oscillator.stop(now + duration + 0.02)
  oscillator.onended = () => context.close()
}

function QuestionVisual({ question }) {
  const [hasImageError, setHasImageError] = useState(false)
  const prompt = getQuestionPrompt(question)
  const imageUrl =
    question.imageUrl || buildQuestionImageUrl(question.imagePrompt || prompt, question.category, { kind: "question" })

  useEffect(() => {
    setHasImageError(false)
  }, [question.id])

  if (hasImageError) {
    return (
      <div className="visual-fallback">
        <span className="visual-label">{question.category}</span>
        <strong>{question.imageAlt || prompt}</strong>
        <p>{prompt}</p>
      </div>
    )
  }

  return (
    <img
      alt={question.imageAlt || prompt}
      className="question-visual"
      onError={() => setHasImageError(true)}
      src={imageUrl}
    />
  )
}

function getQuestionPrompt(question) {
  return question?.prompt || question?.question_text || "Beantwoord de volgende vraag."
}

function ResultsCard({ teams, leaderboard, showGroups = true }) {
  const sortedTeams = [...teams].sort((left, right) => right.score - left.score)
  const winningTeam = sortedTeams[0]
  const topPlayer = leaderboard[0]

  if (!showGroups) {
    return (
      <div className="results-card">
        <span className="eyebrow">Ronde klaar</span>
        <h3>{topPlayer ? `${topPlayer.name} wint deze ronde` : "De ronde is afgelopen"}</h3>
        <p>
          {topPlayer ? `${topPlayer.score} punten voor de winnaar.` : "Bekijk hieronder de eindstand."}
        </p>
        <div className="results-grid">
          {leaderboard.slice(0, 10).map((player, index) => (
            <div className="result-tile" key={player.id}>
              <span>{index + 1}. {player.name}</span>
              <strong>{player.score}</strong>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="results-card">
      <span className="eyebrow">Ronde klaar</span>
      <h3>{winningTeam ? `${winningTeam.name} wint deze ronde` : "De ronde is afgelopen"}</h3>
      <p>
        {winningTeam ? `Eindsaldo: ${winningTeam.score} punten.` : "Bekijk hieronder de eindstand."}
        {topPlayer ? ` Topspeler: ${topPlayer.name} met ${topPlayer.score} punten.` : ""}
      </p>
      <div className="podium">
        {sortedTeams.slice(0, 3).map((team, index) => (
          <div className={`podium-step place-${index + 1}`} key={team.id} style={{ "--team-accent": team.color }}>
            <span className="podium-rank">#{index + 1}</span>
            <strong>{team.name}</strong>
            <b>{team.score}</b>
          </div>
        ))}
      </div>
      <div className="results-grid">
        {sortedTeams.map((team) => (
          <div className="result-tile" key={team.id} style={{ "--team-accent": team.color }}>
            <span>{team.name}</span>
            <strong>{team.score}</strong>
          </div>
        ))}
      </div>
    </div>
  )
}

function BattleRaceBanner({ teams, game, variant = "default" }) {
  const { leader, runnerUp, gap } = getTeamRaceSummary(teams)

  if (!leader) return null

  return (
    <section
      className={`battle-race-banner ${variant === "compact" ? "compact" : ""} ${game.finalSprintActive ? "is-final-sprint" : ""}`}
      style={{ "--team-accent": leader.color }}
    >
      <div>
        <span className="eyebrow">{game.finalSprintActive ? "Finale sprint" : "Koploper"}</span>
        <h3>{leader.name} staat bovenaan</h3>
        <p>
          {runnerUp
            ? `${leader.score} punten, ${gap} voor op ${runnerUp.name}.`
            : `${leader.score} punten in totaal.`}
        </p>
      </div>
      <div className="battle-race-meta">
        <strong>{game.questionMultiplier > 1 ? `x${game.questionMultiplier} punten` : "Live stand"}</strong>
        <span>
          {game.finalSprintActive
            ? "Deze vraag telt dubbel omdat de teams dicht bij elkaar zitten."
            : "Je ziet hier steeds welk team momenteel bovenaan staat."}
        </span>
      </div>
    </section>
  )
}

function ProgressBar({ current, total, timeLeft, duration }) {
  const progress = total ? Math.max(0, Math.min(100, (current / total) * 100)) : 0
  const timeProgress = duration ? Math.max(0, Math.min(100, (timeLeft / duration) * 100)) : 100

  return (
    <div className="progress-stack">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${progress}%` }} />
      </div>
      <div className="progress-track timer-track">
        <div className="progress-fill timer-fill" style={{ width: `${timeProgress}%` }} />
      </div>
    </div>
  )
}

function LobbyCard({
  roomCode,
  teams,
  players,
  onlineCount,
  groupModeEnabled = false,
  joinQrUrl = "",
  joinUrl = "",
  onOpenQr = null,
}) {
  return (
    <div className="lobby-card">
      <span className="eyebrow">Wachtruimte</span>
      <h3>Open de site en voer de sessiecode in</h3>
      <div className="lobby-join-strip">
        <div className="lobby-code">{roomCode || "-----"}</div>
        {joinQrUrl && onOpenQr ? (
          <SessionQrPreviewCard onOpen={onOpenQr} qrCodeUrl={joinQrUrl} roomCode={roomCode} />
        ) : null}
      </div>
      <p>
        Open <strong>/join</strong>, voer de code in en vul je naam in.
        {groupModeEnabled ? " Een groep kiezen is mogelijk, maar niet verplicht." : " Deze sessie werkt individueel, dus een groep kiezen hoeft niet."}
        {" "}Zodra de ronde start, verschijnen de vragen hier live.
        {joinUrl ? " Met de QR-code staat de sessiecode al automatisch klaar." : ""}
      </p>
      <div className="lobby-stats">
        <div className="result-tile">
          <span>{groupModeEnabled ? "Groepen" : "Individueel"}</span>
          <strong>{groupModeEnabled ? teams.length : "Aan"}</strong>
        </div>
        <div className="result-tile">
          <span>Spelers online</span>
          <strong>{onlineCount}</strong>
        </div>
      </div>
    </div>
  )
}

function ScoreBoard({ teams, leaderboard, compact = false, showGroups = true }) {
  const sortedTeams = sortTeamsByScore(teams)

  return (
    <section className={`glass board-card ${compact ? "compact" : ""}`}>
      <div className="section-head">
        <h2>{showGroups ? "Teamscore" : "Spelersscore"}</h2>
        <span className="pill">Live</span>
      </div>
      {showGroups ? (
        <div className="team-score-list">
          {sortedTeams.map((team, index) => (
            <div className={`team-score-card ${index === 0 ? "is-leading" : ""}`} key={team.id} style={{ "--team-accent": team.color }}>
              <div>
                <strong>{team.name}</strong>
                <span>Groepspunten</span>
              </div>
              <b>{team.score}</b>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mini-leaderboard">
        <h3>{showGroups ? "Top spelers" : "Leaderboard"}</h3>
        {leaderboard.slice(0, compact ? 5 : 10).map((player, index) => (
          <div className="mini-row" key={player.id}>
            <span>{index + 1}. {player.name}</span>
            <strong>{player.score}</strong>
          </div>
        ))}
      </div>
    </section>
  )
}

function RosterBoard({
  players,
  teams,
  compact = false,
  onRemovePlayer,
  onlineCount = players.filter((player) => player.connected !== false).length,
  groupModeEnabled = false,
}) {
  const renderRosterRows = (entries, emptyId, emptyLabel) =>
    (entries.length ? entries : [{ id: emptyId, name: emptyLabel, score: 0 }]).map((player) => (
      <div className="roster-row" key={player.id}>
        <div className="roster-row-main">
          <span>{player.name}</span>
          {player.connected === false ? <small className="roster-status-offline">offline</small> : null}
          <strong>{player.score}</strong>
        </div>
        {onRemovePlayer && !String(player.id).endsWith("-empty") ? (
          <button
            className="button-remove-mini"
            onClick={() => onRemovePlayer(player.id)}
            type="button"
          >
            Verwijder
          </button>
        ) : null}
      </div>
    ))

  if (!groupModeEnabled) {
    return (
      <section className={`glass board-card ${compact ? "compact" : ""}`}>
        <div className="section-head">
          <h2>Deelnemers</h2>
          <span className="pill">{onlineCount} online</span>
        </div>
        <div className="roster-grid">
          <div className="roster-column">
            <h3>Alle leerlingen</h3>
            {renderRosterRows(players, "players-empty", "Nog niemand")}
          </div>
        </div>
      </section>
    )
  }

  const ungroupedPlayers = players.filter((player) => !player.teamId)

  return (
    <section className={`glass board-card ${compact ? "compact" : ""}`}>
      <div className="section-head">
        <h2>Deelnemers per groep</h2>
        <span className="pill">{onlineCount} online</span>
      </div>
      <div className="roster-grid">
        {teams.map((team) => (
          <div className="roster-column" key={team.id} style={{ "--team-accent": team.color }}>
            <h3>{team.name}</h3>
            {renderRosterRows(players.filter((player) => player.teamId === team.id), `${team.id}-empty`, "Nog niemand")}
          </div>
        ))}
        {ungroupedPlayers.length ? (
          <div className="roster-column">
            <h3>Zonder groep</h3>
            {renderRosterRows(ungroupedPlayers, "ungrouped-empty", "Nog niemand")}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function buildQuestionImageUrl(prompt, category, options = {}) {
  const searchParams = new URLSearchParams({
    prompt,
    category: category || "",
    kind: options.kind || "question",
    v: IMAGE_RENDER_VERSION,
  })

  return `/api/question-image?${searchParams.toString()}`
}

function HostStartPanel({
  onMailClick,
  onOpenWorkspace,
  onRestoreLocalBackup,
  roomCode,
  onlinePlayerCount,
  liveGroupModeEnabled,
  teamCount,
  game,
  hostSession,
  liveWorkspaceId,
  liveWorkspaceLabel,
  liveStatusText,
  localBackup,
  recentEntries,
}) {
  const liveSummary =
    game.mode === "lesson"
      ? `${game.totalPhases || 0} lesstappen klaar`
      : game.mode === "math"
        ? `${game.math?.players?.length || 0} leerlingen oefenen`
        : game.mode === "battle"
          ? `${game.totalQuestions || 0} vragen in de battle`
          : "Nog geen actieve sessie"

  return (
    <section className="host-start-shell">
      <section className="glass board-card host-start-hero">
        <div className="host-start-copy">
          <span className="eyebrow">Docentenomgeving</span>
          <h1>Rustig starten.</h1>
          <p>
            Kies linksboven alleen de werkruimte die je nu nodig hebt. Zo blijft het scherm rustig en houd je overzicht
            tijdens de les.
          </p>
          <div className="host-start-actions">
            <button className="button-primary" onClick={() => onOpenWorkspace("lesson")} type="button">
              Start met lesmodus
            </button>
            {liveWorkspaceId ? (
              <button className="button-secondary" onClick={() => onOpenWorkspace(liveWorkspaceId)} type="button">
                Open {liveWorkspaceLabel}
              </button>
            ) : (
              <button className="button-secondary" onClick={() => onOpenWorkspace("presentation")} type="button">
                Maak een presentatie
              </button>
            )}
          </div>
        </div>
        <aside className="host-start-sidecard">
          <div className="host-start-summary">
            <div className="host-start-summary-item">
              <span>Sessiecode</span>
              <strong>{roomCode || "-----"}</strong>
            </div>
            <div className="host-start-summary-item">
              <span>Online</span>
              <strong>{onlinePlayerCount}</strong>
            </div>
            <div className="host-start-summary-item">
              <span>Nu live</span>
              <strong>{liveStatusText || liveSummary}</strong>
            </div>
          </div>
          <div className="host-start-visual host-start-visual-compact">
            <div className="host-start-visual-fallback is-visible" aria-hidden="false">
              <div className="host-start-visual-scene">
                <div className="host-start-screen" />
                <div className="host-start-desk" />
                <div className="host-start-figure teacher" />
                <div className="host-start-figure student-a" />
                <div className="host-start-figure student-b" />
                <div className="host-start-figure student-c" />
              </div>
              <div className="host-start-visual-copy">
                <strong>Onderwijsbeeld</strong>
                <span>Vaste illustratie voor een rustige docentstart</span>
              </div>
            </div>
          </div>
        </aside>
      </section>

      <section className="host-start-grid">
        <article className="glass board-card host-overview-card">
          <div className="section-head">
            <h2>Ga verder</h2>
            <span className="pill">Live</span>
          </div>
          <div className="host-overview-list">
            <div className="host-overview-item">
              <span>Actieve sessiecode</span>
              <strong>{roomCode || "-----"}</strong>
            </div>
            <div className="host-overview-item">
              <span>Verbonden leerlingen</span>
              <strong>{onlinePlayerCount}</strong>
            </div>
            <div className="host-overview-item">
              <span>Groepsmodus</span>
              <strong>{liveGroupModeEnabled ? `${teamCount} groepen` : "Uit"}</strong>
            </div>
            <div className="host-overview-item">
              <span>Huidige activiteit</span>
              <strong>{liveSummary}</strong>
            </div>
            <div className="host-overview-item">
              <span>Docentaccount</span>
              <strong>{hostSession.displayName || hostSession.username || "Docent"}</strong>
            </div>
          </div>
          <div className="host-inline-actions">
            {liveWorkspaceId ? (
              <button className="button-secondary" onClick={() => onOpenWorkspace(liveWorkspaceId)} type="button">
                Ga verder in {liveWorkspaceLabel}
              </button>
            ) : (
              <button className="button-secondary" onClick={() => onOpenWorkspace("lesson")} type="button">
                Open eerste werkruimte
              </button>
            )}
            {localBackup?.snapshot ? (
              <button className="button-ghost" onClick={onRestoreLocalBackup} type="button">
                Herstel backup
              </button>
            ) : null}
          </div>
          {localBackup?.savedAt ? (
            <div className="host-home-note">
              Lokale backup beschikbaar van {formatHistoryDate(localBackup.savedAt)}. Daarmee kun je op dit apparaat
              terug naar je laatste sessie.
            </div>
          ) : null}
        </article>

        <article className="glass board-card host-overview-card host-support-card">
          <div className="section-head">
            <h2>Recent en hulp</h2>
            <span className="pill">Vandaag</span>
          </div>
          {recentEntries?.length ? (
            <div className="host-recent-list">
              {recentEntries.map((entry) => (
                <div className="host-recent-item" key={entry.id}>
                  <strong>{entry.title || "Sessie"}</strong>
                  <span>{entry.type === "lesson" ? "Les" : entry.type === "practice" ? "Oefentoets" : entry.type === "battle" ? "Battle" : "Sessie"}</span>
                  <small>{formatHistoryDate(entry.createdAt || entry.date)}</small>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">Hier verschijnen je laatst opgebouwde sessies zodra je die hebt gebruikt of opgeslagen.</p>
          )}
          <div className="host-support-actions">
            <a className="button-primary support-link-button" href={SUPPORT_MAILTO_LINK} onClick={onMailClick}>
              Open mailapp
            </a>
            <button className="button-ghost" onClick={() => onOpenWorkspace("management")} type="button">
              Naar beheer
            </button>
          </div>
          <div className="host-support-meta">
            <span>Ingelogd als</span>
            <strong>{hostSession.displayName || hostSession.username || "Docent"}</strong>
          </div>
        </article>
      </section>
    </section>
  )
}

export default App
