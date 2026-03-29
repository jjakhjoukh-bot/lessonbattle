import crypto from "crypto"
import express from "express"
import fs from "fs"
import Groq from "groq-sdk"
import http from "http"
import OpenAI from "openai"
import path from "path"
import { Server } from "socket.io"
import { fileURLToPath } from "url"
import { GoogleGenerativeAI } from "@google/generative-ai"
import * as XLSX from "xlsx"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.join(__dirname, "..")
const envPath = path.join(projectRoot, ".env")
const clientDistPath = path.join(projectRoot, "client", "dist")
const sharedDataPath = path.join(projectRoot, "shared")
const lessonLibraryPath = path.join(sharedDataPath, "lesson-library.json")
const sessionHistoryPath = path.join(sharedDataPath, "session-history.json")
const activeRoomsPath = path.join(sharedDataPath, "active-rooms.json")
const teacherAccountsPath = path.join(sharedDataPath, "teacher-accounts.json")
const classroomsPath = path.join(sharedDataPath, "classrooms.json")
const mathGrowthHistoryPath = path.join(sharedDataPath, "math-growth-history.json")
const selfPracticeHistoryPath = path.join(sharedDataPath, "self-practice-history.json")
const generatedImagesPath = path.join(sharedDataPath, "generated-images")
const manualImagesPath = path.join(sharedDataPath, "manual-images")
const MAX_SOCKET_PAYLOAD_BYTES = 8 * 1024 * 1024

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
app.set("trust proxy", true)
app.use(express.json({ limit: "8mb" }))
app.use((error, req, res, next) => {
  if (!error) {
    next()
    return
  }
  if (error.type === "entity.too.large") {
    const payload = { message: "De afbeelding is nog te groot om te uploaden. Kies een kleinere afbeelding." }
    if (req.path.startsWith("/api/")) {
      res.status(413).json(payload)
      return
    }
    res.status(413).send(payload.message)
    return
  }
  next(error)
})
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: MAX_SOCKET_PAYLOAD_BYTES,
})

const apiKey = process.env.GEMINI_API_KEY
const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash"
const geminiImageModel = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image"
const groqApiKey = process.env.GROQ_API_KEY
const groqModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile"
const openAIApiKey = process.env.OPENAI_API_KEY
const openAIModel = process.env.OPENAI_MODEL || "gpt-4.1-mini"
const openAIImageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1"
const firebaseProjectId = process.env.FIREBASE_PROJECT_ID || ""
const firebaseClientEmail = process.env.FIREBASE_CLIENT_EMAIL || ""
const firebasePrivateKey = process.env.FIREBASE_PRIVATE_KEY || ""
const firebaseServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || ""
const firestoreDatabaseId = process.env.FIREBASE_FIRESTORE_DATABASE || "(default)"
const port = Number(process.env.PORT || 3001)
const teacherUsername = process.env.TEACHER_USERNAME || "docent"
const teacherPassword = process.env.TEACHER_PASSWORD || "les1234"
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null
const groq = groqApiKey ? new Groq({ apiKey: groqApiKey }) : null
const openAI = openAIApiKey ? new OpenAI({ apiKey: openAIApiKey }) : null
const geminiImageClient = apiKey
  ? new OpenAI({
      apiKey,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    })
  : null
const imageSigningSecret =
  process.env.IMAGE_SIGNING_SECRET ||
  crypto
    .createHash("sha256")
    .update(
      [
        teacherUsername,
        teacherPassword,
        openAIApiKey || "",
        apiKey || "",
        openAIImageModel,
        geminiImageModel,
      ].join("|")
    )
    .digest("hex")

const TEAM_COLORS = ["#ff8c42", "#3dd6d0", "#8f7cff", "#ff5d8f"]
const DEFAULT_TEAMS = ["Team Zon", "Team Oceaan"]
const ROOM_HOST_GRACE_MS = 2 * 60 * 1000
const AI_PROVIDER_REQUEST_TIMEOUT_MS = 45000
const AI_PROVIDER_REPAIR_TIMEOUT_MS = 30000
const AI_ROUND_GENERATION_TIMEOUT_MS = 120000
const AI_RESPONSE_EVALUATION_TIMEOUT_MS = 12000
const AI_IMAGE_TIMEOUT_MS = 20000
const REMOTE_MANUAL_IMAGE_TIMEOUT_MS = 12000
const PUBLIC_IMAGE_QUERY_TIMEOUT_MS = 6500
const PUBLIC_IMAGE_DOWNLOAD_TIMEOUT_MS = 12000
const PUBLIC_IMAGE_QUERY_AI_TIMEOUT_MS = 2500
const LESSON_EVALUATION_CACHE_LIMIT = 500
const SESSION_HISTORY_LIMIT = 120
const MAX_MANUAL_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_REMOTE_IMAGE_BYTES = 5 * 1024 * 1024
const INVALID_IMAGE_SIGNATURE_LIMIT = 12
const INVALID_IMAGE_SIGNATURE_WINDOW_MS = 10 * 60 * 1000
const HOST_SESSION_TTL_MS = 12 * 60 * 60 * 1000
const MATH_LEVELS = ["0f", "1f", "2f", "3f", "4f"]
const MATH_ROOM_GRACE_MS = 7 * 24 * 60 * 60 * 1000
const MATH_INTAKE_QUESTION_COUNT = 16
const MAX_MATH_ANSWER_HISTORY = 24
const MATH_CLOUD_COLLECTION = "lessonBattleMathRooms"
const MATH_CLOUD_RESUME_COLLECTION = "lessonBattleMathResume"
const MATH_CLOUD_HOST_COLLECTION = "lessonBattleMathHosts"
const MATH_CLOUD_GROWTH_COLLECTION = "lessonBattleMathGrowth"
const MAX_AI_ATTACHMENT_COUNT = 3
const MAX_AI_ATTACHMENT_FILE_BYTES = 2 * 1024 * 1024
const MAX_AI_ATTACHMENT_TOTAL_TEXT_CHARS = 42000
const MAX_AI_ATTACHMENT_SNIPPET_CHARS = 14000
const SUPPORTED_AI_ATTACHMENT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".pdf", ".docx", ".xlsx", ".xls"])
const CLASSROOM_CLOUD_COLLECTION = "lessonBattleClassrooms"
const SELF_PRACTICE_CLOUD_COLLECTION = "lessonBattleSelfPractice"
const MATH_CLOUD_SCOPE = "https://www.googleapis.com/auth/datastore"
const MATH_CLOUD_TOKEN_URL = "https://oauth2.googleapis.com/token"
const MATH_CLOUD_PERSIST_DEBOUNCE_MS = 800
const MATH_ACTIVE_WINDOW_MS = 5 * 60 * 1000
const MATH_STALE_WINDOW_MS = 20 * 60 * 1000
const BASE_CORRECT_POINTS = 100
const MAX_SPEED_BONUS = 100
const FINAL_SPRINT_QUESTIONS = 2
const FINAL_SPRINT_CLOSE_GAP = BASE_CORRECT_POINTS + MAX_SPEED_BONUS
const ANSWER_GRACE_MS = 500
const hostSocketIds = new Set()
const hostSessions = new Map()
const hostSessionTokens = new Map()
const socketToRoom = new Map()
const rooms = new Map()
const lessonEvaluationCache = new Map()
const invalidImageSignatureAttempts = new Map()
const mathCloudPersistTimers = new Map()
let mathCloudTokenCache = null
let roomPersistenceTimer = null
let mathGrowthHistory = new Map()
let selfPracticeHistory = new Map()
let classroomsCloudHydrationPromise = null
let selfPracticeCloudHydrationPromise = null

function generateEntityId(prefix = "item") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function ensureSharedDataDir() {
  fs.mkdirSync(sharedDataPath, { recursive: true })
}

function ensureGeneratedImagesDir() {
  ensureSharedDataDir()
  fs.mkdirSync(generatedImagesPath, { recursive: true })
}

function ensureManualImagesDir() {
  ensureSharedDataDir()
  fs.mkdirSync(manualImagesPath, { recursive: true })
}

function createPlayerRecord({
  id = generateEntityId("player"),
  learnerCode = "",
  socketId = null,
  name = "",
  teamId = "",
  classId = "",
  className = "",
  classLearnerId = "",
  score = 0,
  connected = false,
} = {}) {
  return {
    id: String(id),
    learnerCode: String(learnerCode || id).trim() || String(id),
    socketId: socketId ? String(socketId) : null,
    name: String(name).trim(),
    teamId: String(teamId).trim(),
    classId: String(classId).trim(),
    className: String(className).trim(),
    classLearnerId: String(classLearnerId).trim(),
    score: Number(score) || 0,
    connected: Boolean(connected && socketId),
  }
}

function normalizeTeacherUsername(value) {
  return String(value ?? "").trim().toLowerCase()
}

function getRoomOwnerUsername(room) {
  return normalizeTeacherUsername(room?.ownerUsername || "")
}

function normalizeParticipantName(value = "") {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
}

function normalizeMultilineSecret(value = "") {
  return String(value || "")
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .trim()
}

function normalizeIsoDateTime(value = "") {
  const trimmed = String(value ?? "").trim()
  if (!trimmed) return ""
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) return ""
  return parsed.toISOString()
}

function validatePrivateKeyFormat(privateKey = "") {
  const normalized = normalizeMultilineSecret(privateKey)
  if (!normalized) return false
  try {
    crypto.createPrivateKey({ key: normalized, format: "pem" })
    return true
  } catch {
    return false
  }
}

function parseFirebaseServiceAccount() {
  if (firebaseServiceAccountJson.trim()) {
    try {
      const parsed = JSON.parse(firebaseServiceAccountJson)
      return {
        projectId: String(parsed.project_id || parsed.projectId || "").trim(),
        clientEmail: String(parsed.client_email || parsed.clientEmail || "").trim(),
        privateKey: normalizeMultilineSecret(parsed.private_key || parsed.privateKey || ""),
      }
    } catch (error) {
      console.error("FIREBASE_SERVICE_ACCOUNT_JSON kon niet worden gelezen:", error instanceof Error ? error.message : error)
    }
  }

  if (firebaseProjectId.trim() && firebaseClientEmail.trim() && firebasePrivateKey.trim()) {
    return {
      projectId: firebaseProjectId.trim(),
      clientEmail: firebaseClientEmail.trim(),
      privateKey: normalizeMultilineSecret(firebasePrivateKey),
    }
  }

  return null
}

const firebaseServiceAccount = parseFirebaseServiceAccount()
const mathCloudEnabled = Boolean(
  firebaseServiceAccount?.projectId && firebaseServiceAccount?.clientEmail && firebaseServiceAccount?.privateKey
)

if (mathCloudEnabled && !validatePrivateKeyFormat(firebaseServiceAccount.privateKey)) {
  console.error(
    'FIREBASE_PRIVATE_KEY lijkt onjuist geformatteerd. Gebruik de volledige private_key uit het service-account JSON-bestand, inclusief BEGIN/END PRIVATE KEY, zonder extra quotes.'
  )
}

function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ""))
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function buildMathCloudResumeDocId(name = "", learnerCode = "") {
  return crypto.createHash("sha256").update(`${normalizeParticipantName(name)}|${normalizeLearnerCode(learnerCode)}`).digest("hex")
}

function buildMathCloudHostDocId(username = "") {
  return crypto.createHash("sha256").update(normalizeTeacherUsername(username)).digest("hex")
}

function firestoreDocUrl(collectionName, documentId) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseServiceAccount?.projectId || "")}/databases/${encodeURIComponent(firestoreDatabaseId)}/documents/${encodeURIComponent(collectionName)}/${encodeURIComponent(documentId)}`
}

function firestoreCollectionUrl(collectionName) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseServiceAccount?.projectId || "")}/databases/${encodeURIComponent(firestoreDatabaseId)}/documents/${encodeURIComponent(collectionName)}`
}

function firestoreStringField(value = "") {
  return { stringValue: String(value ?? "") }
}

function firestoreBooleanField(value) {
  return { booleanValue: Boolean(value) }
}

function readFirestoreString(document, fieldName, fallback = "") {
  const value = document?.fields?.[fieldName]
  if (!value) return fallback
  if (typeof value.stringValue === "string") return value.stringValue
  if (typeof value.integerValue === "string") return value.integerValue
  if (typeof value.booleanValue === "boolean") return value.booleanValue ? "true" : "false"
  return fallback
}

async function getMathCloudAccessToken() {
  if (!mathCloudEnabled) return ""
  if (mathCloudTokenCache?.token && Date.now() < mathCloudTokenCache.expiresAt) {
    return mathCloudTokenCache.token
  }

  const issuedAt = Math.floor(Date.now() / 1000)
  const jwtHeader = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const jwtPayload = base64UrlEncode(
    JSON.stringify({
      iss: firebaseServiceAccount.clientEmail,
      sub: firebaseServiceAccount.clientEmail,
      aud: MATH_CLOUD_TOKEN_URL,
      scope: MATH_CLOUD_SCOPE,
      iat: issuedAt,
      exp: issuedAt + 3600,
    })
  )
  const unsignedToken = `${jwtHeader}.${jwtPayload}`
  const signer = crypto.createSign("RSA-SHA256")
  signer.update(unsignedToken)
  signer.end()
  let signature = ""
  try {
    signature = base64UrlEncode(
      signer.sign({
        key: firebaseServiceAccount.privateKey,
        format: "pem",
      })
    )
  } catch (error) {
    throw new Error(
      "De Firebase private key kan niet worden gelezen. Controleer in Render of FIREBASE_PRIVATE_KEY de volledige key bevat, zonder extra quotes."
    )
  }
  const assertion = `${unsignedToken}.${signature}`

  const response = await fetch(MATH_CLOUD_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || payload?.error?.message || "Kon geen Firestore toegangstoken ophalen.")
  }

  mathCloudTokenCache = {
    token: payload.access_token,
    expiresAt: Date.now() + Math.max(60, (Number(payload.expires_in) || 3600) - 60) * 1000,
  }
  return mathCloudTokenCache.token
}

async function firestoreRequest(documentUrl, { method = "GET", body = null } = {}) {
  const token = await getMathCloudAccessToken()
  const response = await fetch(documentUrl, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (response.status === 404) return null

  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Firestore verzoek mislukte (${response.status}).`)
  }

  return payload
}

function hashTeacherPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const normalizedPassword = String(password ?? "")
  const passwordHash = crypto.scryptSync(normalizedPassword, salt, 64).toString("hex")
  return { salt, passwordHash }
}

function verifyTeacherPassword(password, account) {
  if (!account?.salt || !account?.passwordHash) return false
  const candidate = crypto.scryptSync(String(password ?? ""), account.salt, 64)
  const stored = Buffer.from(account.passwordHash, "hex")
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate)
}

function createIdleGameState(groupModeEnabled = false) {
  return {
    topic: "",
    audience: "vmbo",
    questionCount: 12,
    questionDurationSec: 20,
    questionStartedAt: null,
    status: "idle",
    answerRevealed: false,
    source: "idle",
    providerLabel: null,
    generatedAt: null,
    mode: "battle",
    lessonModel: "edi",
    lessonDurationMinutes: 45,
    questionMultiplier: 1,
    finalSprintActive: false,
    leadingTeamId: null,
    leadingTeamName: "",
    leadingTeamScore: 0,
    runnerUpTeamId: null,
    runnerUpTeamName: "",
    runnerUpTeamScore: 0,
    leadingGap: 0,
    groupModeEnabled: Boolean(groupModeEnabled),
  }
}

function createEmptyLessonState() {
  return {
    libraryId: null,
    title: "",
    model: "EDI",
    audience: "vmbo",
    durationMinutes: 45,
    lessonGoal: "",
    successCriteria: [],
    materials: [],
    phases: [],
    currentPhaseIndex: -1,
    activePrompt: "",
    activeExpectedAnswer: "",
    activeKeywords: [],
    promptVersion: 0,
    practiceTest: null,
    presentation: null,
    includePracticeTest: false,
    includePresentation: false,
    includeVideoPlan: false,
  }
}

function createEmptyMathState() {
  return {
    title: "",
    assignmentTitle: "",
    dueAt: "",
    classId: "",
    className: "",
    targetPracticeQuestionCount: 12,
    selectedBand: "",
    intakeQuestions: [],
    playerProgress: new Map(),
    startedAt: null,
    updatedAt: null,
  }
}

function normalizeLearnerCode(value = "") {
  return String(value ?? "")
    .trim()
    .replace(/\D/g, "")
    .slice(0, 4)
}

function isValidLearnerCode(value = "") {
  return /^\d{4}$/.test(String(value ?? ""))
}

function normalizeStudentNumber(value = "") {
  return String(value ?? "").trim().slice(0, 32)
}

function generateUniqueLearnerCode(room) {
  const takenCodes = new Set((room?.players || []).map((player) => String(player.learnerCode || "")))
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = String(randomInt(1000, 9999))
    if (!takenCodes.has(candidate)) return candidate
  }
  return `${Date.now()}`.slice(-4)
}

function generateUniqueClassroomLearnerCode(classroom, extraTakenCodes = new Set()) {
  const takenCodes = new Set((classroom?.learners || []).map((learner) => String(learner.learnerCode || "")))
  for (const code of extraTakenCodes) {
    if (code) takenCodes.add(String(code))
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = String(randomInt(1000, 9999))
    if (!takenCodes.has(candidate)) return candidate
  }
  return `${Date.now()}`.slice(-4)
}

function generateNextStudentNumber(existingNumbers = []) {
  let maxNumber = 0
  for (const entry of existingNumbers) {
    const normalized = normalizeStudentNumber(entry)
    if (!/^\d+$/.test(normalized)) continue
    maxNumber = Math.max(maxNumber, Number(normalized))
  }
  return String(maxNumber + 1).padStart(6, "0")
}

function normalizeImportHeaderKey(value = "") {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
}

const CLASSROOM_IMPORT_FIELD_ALIASES = {
  name: [
    "naam",
    "leerling",
    "leerlingnaam",
    "student",
    "studentnaam",
    "name",
    "fullname",
    "volledigenaam",
  ],
  learnerCode: ["leerlingcode", "leercode", "logincode", "incode", "pincode", "code", "passcode"],
  studentNumber: ["leerlingnummer", "studentnummer", "nummer", "studentid", "leerlingid", "studentnumber"],
  className: ["klas", "classname", "class", "groep", "group"],
  sectionName: ["sectie", "vak", "section", "sectionname", "subject"],
  audience: ["doelgroep", "niveau", "audience", "level"],
}

function readImportFieldValue(rawRow = {}, fieldName = "") {
  const aliases = CLASSROOM_IMPORT_FIELD_ALIASES[fieldName] || []
  for (const [rawKey, rawValue] of Object.entries(rawRow || {})) {
    if (aliases.includes(normalizeImportHeaderKey(rawKey))) {
      return String(rawValue ?? "").trim()
    }
  }
  return ""
}

function parseClassroomLearnerImport(fileBuffer, fileName = "") {
  const workbook = XLSX.read(fileBuffer, { type: "buffer" })
  const importedLearners = []
  let detectedClassName = ""
  let detectedSectionName = ""
  let detectedAudience = ""

  for (const sheetName of workbook.SheetNames || []) {
    const worksheet = workbook.Sheets?.[sheetName]
    if (!worksheet) continue
    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "", raw: false })
    for (const rawRow of rows) {
      const name = String(readImportFieldValue(rawRow, "name") || "").trim()
      if (!name) continue
      const learnerCode = normalizeLearnerCode(readImportFieldValue(rawRow, "learnerCode"))
      const studentNumber = normalizeStudentNumber(readImportFieldValue(rawRow, "studentNumber"))
      if (!detectedClassName) {
        detectedClassName = String(readImportFieldValue(rawRow, "className") || "").trim()
      }
      if (!detectedSectionName) {
        detectedSectionName = String(readImportFieldValue(rawRow, "sectionName") || "").trim()
      }
      if (!detectedAudience) {
        detectedAudience = String(readImportFieldValue(rawRow, "audience") || "").trim()
      }
      importedLearners.push({
        id: generateEntityId("class-import-row"),
        name,
        learnerCode,
        studentNumber,
        sourceSheet: sheetName,
        sourceFileName: fileName,
      })
    }
  }

  return {
    learners: importedLearners,
    detectedClassName,
    detectedSectionName,
    detectedAudience,
  }
}

function normalizeMathLevel(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
  return MATH_LEVELS.includes(normalized) ? normalized : MATH_LEVELS[1]
}

function mathLevelIndex(level) {
  return MATH_LEVELS.indexOf(normalizeMathLevel(level))
}

function formatMathLevel(level) {
  return normalizeMathLevel(level).toUpperCase()
}

function getNextMathLevel(level) {
  const index = mathLevelIndex(level)
  return MATH_LEVELS[Math.min(MATH_LEVELS.length - 1, Math.max(0, index + 1))]
}

function clampMathDifficulty(value) {
  return Math.max(1, Math.min(5, Number(value) || 1))
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pickOne(values) {
  return values[randomInt(0, values.length - 1)]
}

function roundTo(value, decimals = 2) {
  const factor = 10 ** decimals
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor
}

function formatMathAnswer(value, decimals = 2) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return String(value ?? "")
  if (Math.abs(numeric - Math.round(numeric)) < 0.000001) return String(Math.round(numeric))
  return numeric.toFixed(decimals).replace(/\.?0+$/, "").replace(".", ",")
}

function parseMathAnswer(rawValue) {
  const normalized = String(rawValue ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(",", ".")
    .replace(/€/g, "")
  if (!normalized) return null
  const match = normalized.match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  const value = Number(match[0])
  return Number.isFinite(value) ? value : null
}

function createMathTask({
  level,
  difficulty = 2,
  prompt = "",
  answer = 0,
  tolerance = 0,
  domain = "rekenen",
  explanation = "",
  hint = "",
  points = 0,
  phase = "practice",
}) {
  const safeLevel = normalizeMathLevel(level)
  const safeDifficulty = clampMathDifficulty(difficulty)
  const safeAnswer = Number(answer)
  return {
    id: generateEntityId("math"),
    level: safeLevel,
    difficulty: safeDifficulty,
    prompt: String(prompt).trim(),
    answer: Number.isFinite(safeAnswer) ? safeAnswer : 0,
    tolerance: Math.max(0, Number(tolerance) || 0),
    domain: String(domain).trim() || "rekenen",
    explanation: String(explanation).trim(),
    hint: String(hint).trim(),
    points: Math.max(5, Number(points) || 5),
    phase,
  }
}

const MATH_DOMAIN_KEYS = ["getallen", "verhoudingen", "meten en meetkunde", "verbanden"]

function pickMathTaskFromBank(bank, preferredDomain = "") {
  const safeDomain = MATH_DOMAIN_KEYS.includes(preferredDomain) ? preferredDomain : ""
  const templates = safeDomain
    ? bank[safeDomain] || []
    : MATH_DOMAIN_KEYS.flatMap((domain) => bank[domain] || [])

  if (!templates.length) {
    throw new Error(`Geen rekentemplates beschikbaar voor domein '${preferredDomain || "alle"}'.`)
  }
  return pickOne(templates)()
}

function generate0FMathTask(difficulty, phase = "practice", preferredDomain = "") {
  const safeDifficulty = clampMathDifficulty(difficulty)
  const bank = {
    getallen: [
      () => {
        const a = randomInt(6, 20 + safeDifficulty * 6)
        const b = randomInt(4, 15 + safeDifficulty * 5)
        return createMathTask({
          level: "0f",
          difficulty: safeDifficulty,
          phase,
          domain: "getallen",
          prompt: `Hoeveel is ${a} + ${b}?`,
          answer: a + b,
          explanation: `Tel eerst ${a}. Tel daarna ${b} erbij. Dan kom je op ${a + b}.`,
          hint: "Begin bij het grootste getal en tel verder.",
          points: 8 + safeDifficulty * 2,
        })
      },
      () => {
        const total = randomInt(18, 40 + safeDifficulty * 8)
        const away = randomInt(3, Math.max(6, total - 5))
        return createMathTask({
          level: "0f",
          difficulty: safeDifficulty,
          phase,
          domain: "getallen",
          prompt: `Je hebt ${total} knikkers. Je geeft er ${away} weg. Hoeveel houd je over?`,
          answer: total - away,
          explanation: `Je begint met ${total}. Daar haal je ${away} af. Dan blijft ${total - away} over.`,
          hint: "Reken het stap voor stap terug.",
          points: 8 + safeDifficulty * 2,
        })
      },
    ],
    verhoudingen: [
      () => {
        const boxes = pickOne([2, 3, 4, 5])
        const perBox = pickOne([2, 3, 4, 5])
        return createMathTask({
          level: "0f",
          difficulty: safeDifficulty,
          phase,
          domain: "verhoudingen",
          prompt: `In 1 doos zitten ${perBox} stiften. Hoeveel stiften zitten er in ${boxes} dozen?`,
          answer: boxes * perBox,
          explanation: `In elke doos zitten ${perBox} stiften. Dus ${boxes} dozen is ${boxes} x ${perBox} = ${boxes * perBox}.`,
          hint: "Tel steeds hetzelfde aantal erbij op.",
          points: 8 + safeDifficulty * 2,
        })
      },
      () => {
        const cookies = pickOne([12, 16, 20, 24])
        const plates = pickOne([2, 4])
        return createMathTask({
          level: "0f",
          difficulty: safeDifficulty,
          phase,
          domain: "verhoudingen",
          prompt: `${cookies} koekjes worden eerlijk verdeeld over ${plates} borden. Hoeveel koekjes komen op 1 bord?`,
          answer: cookies / plates,
          explanation: `Eerlijk verdelen betekent delen. Dus ${cookies} : ${plates} = ${cookies / plates}.`,
          hint: "Verdeel het totaal in gelijke groepjes.",
          points: 8 + safeDifficulty * 2,
        })
      },
    ],
    "meten en meetkunde": [
      () => {
        const euros = pickOne([2, 3, 4, 5])
        const cents = pickOne([20, 50, 80])
        const answer = roundTo(euros + cents / 100, 2)
        return createMathTask({
          level: "0f",
          difficulty: safeDifficulty,
          phase,
          domain: "meten en meetkunde",
          prompt: `Je hebt ${euros} euro en ${cents} cent. Hoeveel euro heb je samen?`,
          answer,
          tolerance: 0.01,
          explanation: `${cents} cent is ${formatMathAnswer(cents / 100)} euro. Samen is dat ${euros} + ${formatMathAnswer(cents / 100)} = ${formatMathAnswer(answer)} euro.`,
          hint: "100 cent is 1 euro.",
          points: 9 + safeDifficulty * 2,
        })
      },
      () => {
        const total = pickOne([80, 95, 120, 150])
        const cut = pickOne([15, 20, 25, 30])
        return createMathTask({
          level: "0f",
          difficulty: safeDifficulty,
          phase,
          domain: "meten en meetkunde",
          prompt: `Een lint is ${total} cm lang. Je knipt ${cut} cm eraf. Hoeveel cm blijft over?`,
          answer: total - cut,
          explanation: `Je haalt ${cut} cm van ${total} cm af. Dan blijft ${total - cut} cm over.`,
          hint: "Trek het afgeknipte stuk van het totaal af.",
          points: 9 + safeDifficulty * 2,
        })
      },
    ],
    verbanden: [
      () => {
        const start = pickOne([2, 3, 4])
        const step = pickOne([2, 5, 10])
        return createMathTask({
          level: "0f",
          difficulty: safeDifficulty,
          phase,
          domain: "verbanden",
          prompt: `In een spaartabel staat: week 1 = ${start} euro, week 2 = ${start + step} euro, week 3 = ${start + step * 2} euro. Hoeveel euro hoort bij week 4?`,
          answer: start + step * 3,
          explanation: `Er komt elke week ${step} euro bij. Dus bij week 4 krijg je ${start + step * 2} + ${step} = ${start + step * 3}.`,
          hint: "Kijk hoeveel er elke stap bijkomt.",
          points: 8 + safeDifficulty * 2,
        })
      },
      () => {
        const jumpA = pickOne([2, 3, 4])
        const jumpB = jumpA + pickOne([1, 2, 3])
        const jumpC = jumpB + pickOne([1, 2, 3])
        return createMathTask({
          level: "0f",
          difficulty: safeDifficulty,
          phase,
          domain: "verbanden",
          prompt: `Noa springt op maandag ${jumpA} meter, op dinsdag ${jumpB} meter en op woensdag ${jumpC} meter. Hoeveel meter springt ze het verst op 1 dag?`,
          answer: Math.max(jumpA, jumpB, jumpC),
          explanation: `Vergelijk de drie afstanden. De grootste afstand is ${Math.max(jumpA, jumpB, jumpC)} meter.`,
          hint: "Zoek het grootste getal.",
          points: 8 + safeDifficulty * 2,
        })
      },
    ],
  }

  return pickMathTaskFromBank(bank, preferredDomain)
}

function generate1FMathTask(difficulty, phase = "practice", preferredDomain = "") {
  const safeDifficulty = clampMathDifficulty(difficulty)
  const bank = {
    getallen: [
      () => {
        const a = randomInt(4, 12)
        const b = randomInt(3, 12)
        return createMathTask({
          level: "1f",
          difficulty: safeDifficulty,
          phase,
          domain: "getallen",
          prompt: `Hoeveel is ${a} x ${b}?`,
          answer: a * b,
          explanation: `${a} keer ${b} is hetzelfde als ${b} groepjes van ${a}. Dat is ${a * b}.`,
          hint: "Gebruik de tafel of splits het in makkelijke stukken.",
          points: 12 + safeDifficulty * 3,
        })
      },
      () => {
        const price = pickOne([1.5, 2.25, 2.5, 3.75, 4.5])
        const count = pickOne([2, 3, 4, 5])
        const answer = roundTo(price * count, 2)
        return createMathTask({
          level: "1f",
          difficulty: safeDifficulty,
          phase,
          domain: "getallen",
          prompt: `Een broodje kost ${formatMathAnswer(price)} euro. Je koopt er ${count}. Hoeveel betaal je samen?`,
          answer,
          tolerance: 0.01,
          explanation: `Je rekent ${count} x ${formatMathAnswer(price)}. Dat is ${formatMathAnswer(answer)} euro.`,
          hint: "Vermenigvuldig de prijs van 1 broodje met het aantal broodjes.",
          points: 13 + safeDifficulty * 3,
        })
      },
    ],
    verhoudingen: [
      () => {
        const percent = pickOne([10, 25, 50])
        const base = pickOne([40, 60, 80, 100, 120, 200])
        const answer = roundTo((percent / 100) * base, 2)
        return createMathTask({
          level: "1f",
          difficulty: safeDifficulty,
          phase,
          domain: "verhoudingen",
          prompt: `Hoeveel is ${percent}% van ${base}?`,
          answer,
          tolerance: 0.01,
          explanation: `${percent}% betekent ${percent} van de 100. Van ${base} is dat ${formatMathAnswer(answer)}.`,
          hint: "Denk aan 10%, 25% of de helft.",
          points: 13 + safeDifficulty * 3,
        })
      },
      () => {
        const actualMetersPerCentimeter = pickOne([100, 200, 500])
        const mapDistance = pickOne([2, 3, 4, 5, 6])
        const answer = actualMetersPerCentimeter * mapDistance
        return createMathTask({
          level: "1f",
          difficulty: safeDifficulty,
          phase,
          domain: "verhoudingen",
          prompt: `Op een plattegrond is 1 cm in het echt ${actualMetersPerCentimeter} meter. Twee plekken liggen ${mapDistance} cm uit elkaar op de kaart. Hoeveel meter is dat in het echt?`,
          answer,
          explanation: `Elke centimeter is ${actualMetersPerCentimeter} meter. Dus ${mapDistance} cm is ${mapDistance} x ${actualMetersPerCentimeter} = ${answer} meter.`,
          hint: "Reken eerst uit wat 1 cm betekent en vermenigvuldig daarna.",
          points: 14 + safeDifficulty * 3,
        })
      },
    ],
    "meten en meetkunde": [
      () => {
        const width = pickOne([4, 5, 6, 7, 8])
        const height = pickOne([3, 4, 5, 6, 7])
        const answer = 2 * (width + height)
        return createMathTask({
          level: "1f",
          difficulty: safeDifficulty,
          phase,
          domain: "meten en meetkunde",
          prompt: `Een rechthoek is ${width} cm lang en ${height} cm breed. Hoeveel cm is de omtrek?`,
          answer,
          explanation: `De omtrek is alle kanten samen: ${width} + ${height} + ${width} + ${height} = ${answer} cm.`,
          hint: "Bij een rechthoek tel je lengte en breedte twee keer.",
          points: 14 + safeDifficulty * 3,
        })
      },
      () => {
        const meters = pickOne([1.5, 2.25, 3.5, 4.75])
        const answer = roundTo(meters * 100, 2)
        return createMathTask({
          level: "1f",
          difficulty: safeDifficulty,
          phase,
          domain: "meten en meetkunde",
          prompt: `Hoeveel centimeter is ${formatMathAnswer(meters)} meter?`,
          answer,
          tolerance: 0.01,
          explanation: `1 meter is 100 centimeter. Dus ${formatMathAnswer(meters)} meter is ${formatMathAnswer(answer)} centimeter.`,
          hint: "Vermenigvuldig het aantal meters met 100.",
          points: 13 + safeDifficulty * 3,
        })
      },
    ],
    verbanden: [
      () => {
        const first = pickOne([3, 4, 5])
        const step = pickOne([2, 3, 4])
        return createMathTask({
          level: "1f",
          difficulty: safeDifficulty,
          phase,
          domain: "verbanden",
          prompt: `In een tabel staat: rit 1 = ${first} km, rit 2 = ${first + step} km, rit 3 = ${first + step * 2} km. Hoeveel km hoort bij rit 5?`,
          answer: first + step * 4,
          explanation: `Elke rit komt er ${step} km bij. Dus rit 5 is ${first + step * 4} km.`,
          hint: "Kijk hoeveel er per stap bijkomt en tel door.",
          points: 12 + safeDifficulty * 3,
        })
      },
      () => {
        const klas1 = pickOne([18, 20, 22])
        const klas2 = klas1 + pickOne([2, 3, 4])
        const klas3 = klas2 + pickOne([1, 2, 3])
        return createMathTask({
          level: "1f",
          difficulty: safeDifficulty,
          phase,
          domain: "verbanden",
          prompt: `Een staafdiagram laat zien: klas A = ${klas1} leerlingen, klas B = ${klas2} leerlingen, klas C = ${klas3} leerlingen. Hoeveel leerlingen heeft klas B?`,
          answer: klas2,
          explanation: `Je leest in het diagram het getal bij klas B af. Dat is ${klas2}.`,
          hint: "Lees alleen de juiste balk af.",
          points: 12 + safeDifficulty * 3,
        })
      },
    ],
  }

  return pickMathTaskFromBank(bank, preferredDomain)
}

function generate2FMathTask(difficulty, phase = "practice", preferredDomain = "") {
  const safeDifficulty = clampMathDifficulty(difficulty)
  const bank = {
    getallen: [
      () => {
        const a = pickOne([2.4, 3.75, 4.6, 5.25, 7.8])
        const b = pickOne([1.35, 2.2, 2.75, 3.4])
        const answer = roundTo(a + b, 2)
        return createMathTask({
          level: "2f",
          difficulty: safeDifficulty,
          phase,
          domain: "getallen",
          prompt: `Hoeveel is ${formatMathAnswer(a)} + ${formatMathAnswer(b)}?`,
          answer,
          tolerance: 0.01,
          explanation: `Tel de hele getallen en decimalen netjes bij elkaar op. Dan krijg je ${formatMathAnswer(answer)}.`,
          hint: "Zet de komma's recht onder elkaar in je hoofd of op papier.",
          points: 18 + safeDifficulty * 4,
        })
      },
      () => {
        const total = pickOne([48, 56, 72, 84, 96])
        const fraction = pickOne([
          { label: "3/4", value: 0.75 },
          { label: "2/3", value: 2 / 3 },
          { label: "5/6", value: 5 / 6 },
        ])
        const answer = roundTo(total * fraction.value, 2)
        return createMathTask({
          level: "2f",
          difficulty: safeDifficulty,
          phase,
          domain: "getallen",
          prompt: `Hoeveel is ${fraction.label} van ${total}?`,
          answer,
          tolerance: 0.01,
          explanation: `Je deelt ${total} eerst door de noemer en vermenigvuldigt daarna met de teller. Dan krijg je ${formatMathAnswer(answer)}.`,
          hint: "Eerst delen, daarna vermenigvuldigen.",
          points: 18 + safeDifficulty * 4,
        })
      },
    ],
    verhoudingen: [
      () => {
        const price = pickOne([60, 80, 120, 160, 240])
        const discount = pickOne([15, 20, 25, 30])
        const answer = roundTo(price * (1 - discount / 100), 2)
        return createMathTask({
          level: "2f",
          difficulty: safeDifficulty,
          phase,
          domain: "verhoudingen",
          prompt: `Een jas kost ${price} euro. Er gaat ${discount}% korting af. Wat betaal je dan?`,
          answer,
          tolerance: 0.01,
          explanation: `Na ${discount}% korting blijft ${100 - discount}% over. Dat is ${formatMathAnswer(answer)} euro.`,
          hint: "Reken uit hoeveel procent je nog wel betaalt.",
          points: 19 + safeDifficulty * 4,
        })
      },
      () => {
        const scale = pickOne([10000, 25000, 50000])
        const mapDistance = pickOne([4, 5, 6, 8])
        const answer = roundTo((mapDistance * scale) / 100000, 2)
        return createMathTask({
          level: "2f",
          difficulty: safeDifficulty,
          phase,
          domain: "verhoudingen",
          prompt: `Op een kaart met schaal 1 : ${scale.toLocaleString("nl-NL")} is een route ${mapDistance} cm. Hoeveel kilometer is die route in het echt?`,
          answer,
          tolerance: 0.01,
          explanation: `Bij schaal 1 : ${scale.toLocaleString("nl-NL")} is 1 cm op de kaart ${scale} cm in het echt. Reken dat om naar kilometer. Dan krijg je ${formatMathAnswer(answer)} km.`,
          hint: "Reken eerst naar echte centimeters en daarna naar kilometers.",
          points: 20 + safeDifficulty * 4,
        })
      },
    ],
    "meten en meetkunde": [
      () => {
        const width = pickOne([3.2, 4.5, 5.6, 6.8])
        const length = pickOne([4.5, 5.5, 6.2, 7.4])
        const answer = roundTo(width * length, 2)
        return createMathTask({
          level: "2f",
          difficulty: safeDifficulty,
          phase,
          domain: "meten en meetkunde",
          prompt: `Een kamer is ${formatMathAnswer(length)} m lang en ${formatMathAnswer(width)} m breed. Wat is de oppervlakte in m2?`,
          answer,
          tolerance: 0.01,
          explanation: `Oppervlakte van een rechthoek is lengte x breedte. Dus ${formatMathAnswer(length)} x ${formatMathAnswer(width)} = ${formatMathAnswer(answer)} m2.`,
          hint: "Gebruik lengte x breedte.",
          points: 19 + safeDifficulty * 4,
        })
      },
      () => {
        const liters = pickOne([1.5, 2.25, 3.75, 4.5])
        const answer = roundTo(liters * 1000, 2)
        return createMathTask({
          level: "2f",
          difficulty: safeDifficulty,
          phase,
          domain: "meten en meetkunde",
          prompt: `Hoeveel milliliter is ${formatMathAnswer(liters)} liter?`,
          answer,
          tolerance: 0.01,
          explanation: `1 liter is 1000 milliliter. Dus ${formatMathAnswer(liters)} liter is ${formatMathAnswer(answer)} milliliter.`,
          hint: "Vermenigvuldig liters met 1000.",
          points: 18 + safeDifficulty * 4,
        })
      },
    ],
    verbanden: [
      () => {
        const values = [pickOne([6, 7, 8]), pickOne([7, 8, 9]), pickOne([8, 9, 10]), pickOne([9, 10, 11])]
        const answer = roundTo(values.reduce((sum, value) => sum + value, 0) / values.length, 2)
        return createMathTask({
          level: "2f",
          difficulty: safeDifficulty,
          phase,
          domain: "verbanden",
          prompt: `Je hebt de cijfers ${values.join(", ")}. Wat is het gemiddelde?`,
          answer,
          tolerance: 0.01,
          explanation: `Tel alle cijfers op en deel door ${values.length}. Dan krijg je ${formatMathAnswer(answer)}.`,
          hint: "Gemiddelde = som van alles gedeeld door het aantal getallen.",
          points: 18 + safeDifficulty * 4,
        })
      },
      () => {
        const start = pickOne([5, 8, 10])
        const step = pickOne([3, 4, 5])
        const index = pickOne([6, 7, 8])
        const answer = start + step * (index - 1)
        return createMathTask({
          level: "2f",
          difficulty: safeDifficulty,
          phase,
          domain: "verbanden",
          prompt: `In een tabel kost 1 kaartje ${start} euro. Elk extra kaartje kost ook ${step} euro extra. Wat kosten ${index} kaartjes samen?`,
          answer,
          explanation: `Je begint met ${start} euro voor 1 kaartje. Daarna komen er ${index - 1} stappen van ${step} euro bij. Samen is dat ${answer} euro.`,
          hint: `Reken vanaf 1 kaartje door naar ${index} kaartjes.`,
          points: 19 + safeDifficulty * 4,
        })
      },
    ],
  }

  return pickMathTaskFromBank(bank, preferredDomain)
}

function generate3FMathTask(difficulty, phase = "practice", preferredDomain = "") {
  const safeDifficulty = clampMathDifficulty(difficulty)
  const bank = {
    getallen: [
      () => {
        const a = pickOne([1.8, 2.4, 3.6, 4.25])
        const b = pickOne([1.25, 1.5, 2.2, 2.75])
        const answer = roundTo(a * b, 2)
        return createMathTask({
          level: "3f",
          difficulty: safeDifficulty,
          phase,
          domain: "getallen",
          prompt: `Hoeveel is ${formatMathAnswer(a)} x ${formatMathAnswer(b)}?`,
          answer,
          tolerance: 0.01,
          explanation: `Vermenigvuldig de getallen en zet daarna de komma op de juiste plek. Dan krijg je ${formatMathAnswer(answer)}.`,
          hint: "Je mag dit ook eerst zonder komma uitrekenen en daarna terugplaatsen.",
          points: 24 + safeDifficulty * 5,
        })
      },
      () => {
        const start = pickOne([-4, -3, -2, 5])
        const change = pickOne([7, 8, 9, 10])
        const answer = start + change
        return createMathTask({
          level: "3f",
          difficulty: safeDifficulty,
          phase,
          domain: "getallen",
          prompt: `De temperatuur is ${start} graden en stijgt met ${change} graden. Wat is de nieuwe temperatuur?`,
          answer,
          explanation: `Je telt de stijging op bij de begintemperatuur: ${start} + ${change} = ${answer}.`,
          hint: "Begin op het startgetal en tel omhoog.",
          points: 23 + safeDifficulty * 5,
        })
      },
    ],
    verhoudingen: [
      () => {
        const original = pickOne([80, 120, 150, 200, 240])
        const discount = pickOne([10, 20, 25, 30])
        const paid = roundTo(original * (1 - discount / 100), 2)
        return createMathTask({
          level: "3f",
          difficulty: safeDifficulty,
          phase,
          domain: "verhoudingen",
          prompt: `Na ${discount}% korting betaal je ${formatMathAnswer(paid)} euro. Wat was de oude prijs?`,
          answer: original,
          tolerance: 0.01,
          explanation: `Je betaalde nog ${100 - discount}% van de oude prijs. Daarom deel je ${formatMathAnswer(paid)} door ${formatMathAnswer((100 - discount) / 100)}. Dan krijg je ${original}.`,
          hint: "Bedenk eerst welk percentage overblijft na korting.",
          points: 25 + safeDifficulty * 5,
        })
      },
      () => {
        const price = pickOne([250, 400, 650, 800])
        const increase = pickOne([6, 8, 12, 15])
        const answer = roundTo(price * (1 + increase / 100), 2)
        return createMathTask({
          level: "3f",
          difficulty: safeDifficulty,
          phase,
          domain: "verhoudingen",
          prompt: `Een scooter kost ${price} euro en wordt ${increase}% duurder. Wat is de nieuwe prijs?`,
          answer,
          tolerance: 0.01,
          explanation: `Je rekent ${increase}% erbij. Dus je vermenigvuldigt met ${formatMathAnswer(1 + increase / 100)}. Dan krijg je ${formatMathAnswer(answer)} euro.`,
          hint: "Meer procent betekent groeifactor 1 + percentage.",
          points: 25 + safeDifficulty * 5,
        })
      },
    ],
    "meten en meetkunde": [
      () => {
        const speed = pickOne([18, 24, 30, 45, 60])
        const hours = pickOne([1.5, 2, 2.25, 2.5, 3])
        const answer = roundTo(speed * hours, 2)
        return createMathTask({
          level: "3f",
          difficulty: safeDifficulty,
          phase,
          domain: "meten en meetkunde",
          prompt: `Je fietst ${speed} km per uur en rijdt ${formatMathAnswer(hours)} uur. Hoeveel kilometer leg je af?`,
          answer,
          tolerance: 0.01,
          explanation: `Afstand = snelheid x tijd. Dus ${speed} x ${formatMathAnswer(hours)} = ${formatMathAnswer(answer)} kilometer.`,
          hint: "Gebruik de formule afstand = snelheid x tijd.",
          points: 24 + safeDifficulty * 5,
        })
      },
      () => {
        const radius = pickOne([3, 4, 5, 6, 7])
        const answer = roundTo(2 * Math.PI * radius, 2)
        return createMathTask({
          level: "3f",
          difficulty: safeDifficulty,
          phase,
          domain: "meten en meetkunde",
          prompt: `Een cirkel heeft straal ${radius} cm. Hoeveel cm is de omtrek? Rond af op 2 decimalen.`,
          answer,
          tolerance: 0.05,
          explanation: `De omtrek van een cirkel is 2 x pi x straal. Dus 2 x pi x ${radius} = ${formatMathAnswer(answer)} cm.`,
          hint: "Gebruik 2 x pi x straal.",
          points: 25 + safeDifficulty * 5,
        })
      },
    ],
    verbanden: [
      () => {
        const x = randomInt(4, 14)
        const multiplier = pickOne([2, 3, 4, 5])
        const add = randomInt(3, 12)
        const total = multiplier * x + add
        return createMathTask({
          level: "3f",
          difficulty: safeDifficulty,
          phase,
          domain: "verbanden",
          prompt: `Los op: ${multiplier}x + ${add} = ${total}. Wat is x?`,
          answer: x,
          explanation: `Haal eerst ${add} van ${total} af. Deel daarna door ${multiplier}. Dan krijg je x = ${x}.`,
          hint: "Werk stap voor stap terug.",
          points: 24 + safeDifficulty * 5,
        })
      },
      () => {
        const start = pickOne([10, 15, 20])
        const step = pickOne([4, 5, 6])
        const x = pickOne([7, 8, 9])
        const answer = start + step * x
        return createMathTask({
          level: "3f",
          difficulty: safeDifficulty,
          phase,
          domain: "verbanden",
          prompt: `Bij de formule y = ${step}x + ${start}, wat is y als x = ${x}?`,
          answer,
          explanation: `Vul ${x} in op de plek van x. Dan krijg je y = ${step} x ${x} + ${start} = ${answer}.`,
          hint: "Vervang x door het gegeven getal en reken uit.",
          points: 23 + safeDifficulty * 5,
        })
      },
    ],
  }

  return pickMathTaskFromBank(bank, preferredDomain)
}

function generate4FMathTask(difficulty, phase = "practice", preferredDomain = "") {
  const safeDifficulty = clampMathDifficulty(difficulty)
  const bank = {
    getallen: [
      () => {
        const principal = pickOne([500, 750, 1000, 1200, 1500])
        const rate = pickOne([2, 3, 4, 5])
        const years = pickOne([2, 3, 4])
        const answer = roundTo(principal * (1 + rate / 100) ** years, 2)
        return createMathTask({
          level: "4f",
          difficulty: safeDifficulty,
          phase,
          domain: "getallen",
          prompt: `Je zet ${principal} euro op de bank tegen ${rate}% rente per jaar. Hoeveel staat er na ${years} jaar op de rekening?`,
          answer,
          tolerance: 0.05,
          explanation: `Elk jaar groeit het bedrag opnieuw. Daarom reken je ${principal} x (1 + ${formatMathAnswer(rate / 100)})^${years}. Dat geeft ${formatMathAnswer(answer)} euro.`,
          hint: "Gebruik samengestelde rente: beginbedrag x groeifactor^jaren.",
          points: 30 + safeDifficulty * 6,
        })
      },
      () => {
        const growth = pickOne([1.03, 1.05, 1.08, 1.12])
        const years = pickOne([3, 4, 5])
        const start = pickOne([200, 400, 800])
        const answer = roundTo(start * growth ** years, 2)
        return createMathTask({
          level: "4f",
          difficulty: safeDifficulty,
          phase,
          domain: "getallen",
          prompt: `Een bedrag van ${start} euro groeit ${years} jaar lang met factor ${formatMathAnswer(growth)}. Hoeveel euro heb je dan?`,
          answer,
          tolerance: 0.05,
          explanation: `Je vermenigvuldigt ${years} keer met de groeifactor ${formatMathAnswer(growth)}. Dan krijg je ${formatMathAnswer(answer)} euro.`,
          hint: "Gebruik startbedrag x groeifactor^tijd.",
          points: 30 + safeDifficulty * 6,
        })
      },
    ],
    verhoudingen: [
      () => {
        const excl = pickOne([80, 120, 175, 240])
        const vat = 21
        const answer = roundTo(excl * 1.21, 2)
        return createMathTask({
          level: "4f",
          difficulty: safeDifficulty,
          phase,
          domain: "verhoudingen",
          prompt: `Een product kost ${excl} euro zonder btw. Hoeveel betaal je met ${vat}% btw erbij?`,
          answer,
          tolerance: 0.01,
          explanation: `Met btw betaal je 121% van de prijs zonder btw. Dus ${excl} x 1,21 = ${formatMathAnswer(answer)} euro.`,
          hint: "Gebruik een groeifactor van 1,21.",
          points: 30 + safeDifficulty * 6,
        })
      },
      () => {
        const afterTax = pickOne([144, 180, 216, 242])
        const tax = pickOne([20, 25])
        const answer = roundTo(afterTax / (1 + tax / 100), 2)
        return createMathTask({
          level: "4f",
          difficulty: safeDifficulty,
          phase,
          domain: "verhoudingen",
          prompt: `Na ${tax}% opslag kost een kaartje ${afterTax} euro. Wat was de prijs eerst?`,
          answer,
          tolerance: 0.05,
          explanation: `Na opslag is het bedrag ${100 + tax}% van eerst. Daarom deel je door ${formatMathAnswer(1 + tax / 100)}. Dan krijg je ${formatMathAnswer(answer)} euro.`,
          hint: "Reken terug met de groeifactor.",
          points: 29 + safeDifficulty * 6,
        })
      },
    ],
    "meten en meetkunde": [
      () => {
        const radius = pickOne([2.5, 3, 3.5, 4])
        const height = pickOne([8, 10, 12, 15])
        const answer = roundTo(Math.PI * radius * radius * height, 2)
        return createMathTask({
          level: "4f",
          difficulty: safeDifficulty,
          phase,
          domain: "meten en meetkunde",
          prompt: `Een cilinder heeft straal ${formatMathAnswer(radius)} cm en hoogte ${height} cm. Wat is de inhoud in cm3? Rond af op 2 decimalen.`,
          answer,
          tolerance: 0.1,
          explanation: `Inhoud cilinder = pi x straal x straal x hoogte. Dat wordt ${formatMathAnswer(answer)} cm3.`,
          hint: "Gebruik pi x r x r x h.",
          points: 30 + safeDifficulty * 6,
        })
      },
      () => {
        const width = pickOne([4, 5, 6])
        const height = pickOne([6, 7, 8])
        const cutWidth = pickOne([1.5, 2, 2.5])
        const cutHeight = pickOne([2, 3, 3.5])
        const answer = roundTo(width * height - cutWidth * cutHeight, 2)
        return createMathTask({
          level: "4f",
          difficulty: safeDifficulty,
          phase,
          domain: "meten en meetkunde",
          prompt: `Een L-vorm ontstaat uit een rechthoek van ${width} m bij ${height} m waar een hoek van ${formatMathAnswer(cutWidth)} m bij ${formatMathAnswer(cutHeight)} m uit is gehaald. Wat is de oppervlakte in m2?`,
          answer,
          tolerance: 0.01,
          explanation: `Reken eerst de grote rechthoek uit en haal daarna het uitgesneden stuk eraf. Dan blijft ${formatMathAnswer(answer)} m2 over.`,
          hint: "Grote oppervlakte min kleine uitgesneden oppervlakte.",
          points: 29 + safeDifficulty * 6,
        })
      },
    ],
    verbanden: [
      () => {
        const x = pickOne([4, 5, 6, 7, 8, 9])
        const offset = pickOne([2, 3, 4, 5])
        const total = 2 * (x - offset) + 5
        return createMathTask({
          level: "4f",
          difficulty: safeDifficulty,
          phase,
          domain: "verbanden",
          prompt: `Los op: 2(x - ${offset}) + 5 = ${total}. Wat is x?`,
          answer: x,
          explanation: `Werk eerst de +5 weg, deel daarna door 2 en tel als laatste ${offset} erbij op. Dan krijg je x = ${x}.`,
          hint: "Werk terug in de omgekeerde volgorde.",
          points: 29 + safeDifficulty * 6,
        })
      },
      () => {
        const slope = pickOne([2, 3, 4, 5])
        const intercept = pickOne([6, 8, 10, 12])
        const x = pickOne([7, 8, 9])
        const answer = slope * x + intercept
        return createMathTask({
          level: "4f",
          difficulty: safeDifficulty,
          phase,
          domain: "verbanden",
          prompt: `Bij de formule y = ${slope}x + ${intercept}, wat is y als x = ${x}?`,
          answer,
          explanation: `Vul ${x} in voor x. Dan krijg je y = ${slope} x ${x} + ${intercept} = ${answer}.`,
          hint: "Vervang x door het gegeven getal en reken uit.",
          points: 28 + safeDifficulty * 6,
        })
      },
    ],
  }

  return pickMathTaskFromBank(bank, preferredDomain)
}

function generateMathTaskForLevel(level, difficulty = 2, phase = "practice", preferredDomain = "") {
  const safeLevel = normalizeMathLevel(level)
  if (safeLevel === "0f") return generate0FMathTask(difficulty, phase, preferredDomain)
  if (safeLevel === "1f") return generate1FMathTask(difficulty, phase, preferredDomain)
  if (safeLevel === "2f") return generate2FMathTask(difficulty, phase, preferredDomain)
  if (safeLevel === "3f") return generate3FMathTask(difficulty, phase, preferredDomain)
  return generate4FMathTask(difficulty, phase, preferredDomain)
}

function buildLevelIntakeTasks(level, count, baseDifficulty = 1) {
  return Array.from({ length: count }, (_, index) => {
    const domain = MATH_DOMAIN_KEYS[index % MATH_DOMAIN_KEYS.length]
    const difficulty = clampMathDifficulty(baseDifficulty + Math.floor(index / MATH_DOMAIN_KEYS.length))
    return generateMathTaskForLevel(level, difficulty, "intake", domain)
  })
}

function buildMathIntakePlan(selectedBand) {
  const safeBand = normalizeMathLevel(selectedBand)
  const bandIndex = mathLevelIndex(safeBand)
  const previousLevel = MATH_LEVELS[Math.max(0, bandIndex - 1)]
  const nextLevel = MATH_LEVELS[Math.min(MATH_LEVELS.length - 1, bandIndex + 1)]

  if (bandIndex === 0) {
    return [...buildLevelIntakeTasks("0f", 8, 1), ...buildLevelIntakeTasks("1f", 8, 2)].slice(0, MATH_INTAKE_QUESTION_COUNT)
  }

  if (bandIndex === MATH_LEVELS.length - 1) {
    return [...buildLevelIntakeTasks(previousLevel, 8, 2), ...buildLevelIntakeTasks("4f", 8, 3)].slice(0, MATH_INTAKE_QUESTION_COUNT)
  }

  return [
    ...buildLevelIntakeTasks(previousLevel, 4, 1),
    ...buildLevelIntakeTasks(safeBand, 8, 2),
    ...buildLevelIntakeTasks(nextLevel, 4, 3),
  ].slice(0, MATH_INTAKE_QUESTION_COUNT)
}

function buildMathSession(selectedBand = MATH_LEVELS[1], options = {}) {
  const safeBand = normalizeMathLevel(selectedBand)
  const now = new Date().toISOString()
  return {
    title: String(options.title || "").trim() || `Rekenroute ${formatMathLevel(safeBand)}`,
    assignmentTitle: String(options.assignmentTitle || "").trim() || "",
    dueAt: normalizeIsoDateTime(options.dueAt),
    classId: String(options.classId || "").trim(),
    className: String(options.className || "").trim(),
    targetPracticeQuestionCount: Math.max(4, Math.min(50, Number(options.targetPracticeQuestionCount) || 12)),
    selectedBand: safeBand,
    intakeQuestions: buildMathIntakePlan(safeBand),
    playerProgress: new Map(),
    startedAt: now,
    updatedAt: now,
  }
}

function cloneMathTask(task) {
  if (!task || typeof task !== "object") return null
  return {
    ...task,
    prompt: String(task.prompt ?? "").trim(),
    explanation: String(task.explanation ?? "").trim(),
    hint: String(task.hint ?? "").trim(),
    level: normalizeMathLevel(task.level),
    difficulty: clampMathDifficulty(task.difficulty),
    answer: Number(task.answer) || 0,
    tolerance: Math.max(0, Number(task.tolerance) || 0),
    points: Math.max(5, Number(task.points) || 5),
    phase: String(task.phase ?? "practice"),
  }
}

function createMathProgress(mathState, playerId) {
  const firstTask = mathState?.intakeQuestions?.[0] ? cloneMathTask(mathState.intakeQuestions[0]) : null
  return {
    playerId,
    phase: firstTask ? "intake" : "practice",
    intakeIndex: 0,
    intakeAnswers: [],
    intakeRetryTaskId: "",
    answerHistory: [],
    placementLevel: "",
    targetLevel: "",
    practiceDifficulty: 2,
    streak: 0,
    practiceQuestionCount: 0,
    practiceCorrectCount: 0,
    currentTask: firstTask,
    awaitingNext: false,
    lastResult: null,
    lastAnsweredAt: null,
    updatedAt: new Date().toISOString(),
  }
}

function ensureMathProgress(room, playerId) {
  if (!room?.math?.selectedBand) return null
  const existing = room.math.playerProgress.get(playerId)
  if (existing) return existing
  const created = createMathProgress(room.math, playerId)
  room.math.playerProgress.set(playerId, created)
  room.math.updatedAt = new Date().toISOString()
  return created
}

function determineMathPlacement(mathState, progress) {
  const attemptedLevels = new Map()
  for (const answer of progress?.intakeAnswers || []) {
    const level = normalizeMathLevel(answer.level)
    const bucket =
      attemptedLevels.get(level) ||
      {
        total: 0,
        correct: 0,
        domains: new Map(),
      }
    bucket.total += 1
    if (answer.correct) bucket.correct += 1
    const domainKey = MATH_DOMAIN_KEYS.includes(answer.domain) ? answer.domain : "getallen"
    const domainBucket = bucket.domains.get(domainKey) || { total: 0, correct: 0 }
    domainBucket.total += 1
    if (answer.correct) domainBucket.correct += 1
    bucket.domains.set(domainKey, domainBucket)
    attemptedLevels.set(level, bucket)
  }

  const attemptedOrder = [...attemptedLevels.keys()].sort((left, right) => mathLevelIndex(left) - mathLevelIndex(right))
  const fallbackLevel = attemptedOrder[0] || normalizeMathLevel(mathState?.selectedBand || MATH_LEVELS[1])
  let placement = fallbackLevel

  for (const level of attemptedOrder) {
    const bucket = attemptedLevels.get(level)
    if (!bucket?.total) continue
    const overallRate = bucket.correct / bucket.total
    const overallThreshold = bucket.total >= 8 ? 0.75 : 1
    const hasBroadCoverage =
      bucket.total >= 8
        ? MATH_DOMAIN_KEYS.every((domainKey) => {
            const domainBucket = bucket.domains.get(domainKey)
            if (!domainBucket?.total) return false
            return domainBucket.correct / domainBucket.total >= 0.5
          })
        : true

    if (overallRate >= overallThreshold && hasBroadCoverage) {
      placement = level
    }
  }

  return placement
}

function createMathDomainPerformanceBucket(domain) {
  return {
    domain,
    total: 0,
    correct: 0,
    intakeTotal: 0,
    intakeCorrect: 0,
    practiceTotal: 0,
    practiceCorrect: 0,
    recentTotal: 0,
    recentCorrect: 0,
  }
}

function collectMathDomainPerformance(progress) {
  const stats = new Map(MATH_DOMAIN_KEYS.map((domain) => [domain, createMathDomainPerformanceBucket(domain)]))

  for (const answer of progress?.intakeAnswers || []) {
    const domainKey = MATH_DOMAIN_KEYS.includes(answer?.domain) ? answer.domain : "getallen"
    const bucket = stats.get(domainKey) || createMathDomainPerformanceBucket(domainKey)
    bucket.total += 1
    bucket.intakeTotal += 1
    if (answer?.correct) {
      bucket.correct += 1
      bucket.intakeCorrect += 1
    }
    stats.set(domainKey, bucket)
  }

  const practiceEntries = (progress?.answerHistory || []).filter(
    (entry) => entry?.phase === "practice" && MATH_DOMAIN_KEYS.includes(entry?.domain)
  )

  for (const entry of practiceEntries) {
    const bucket = stats.get(entry.domain) || createMathDomainPerformanceBucket(entry.domain)
    bucket.total += 1
    bucket.practiceTotal += 1
    if (entry.correct) {
      bucket.correct += 1
      bucket.practiceCorrect += 1
    }
    stats.set(entry.domain, bucket)
  }

  for (const entry of practiceEntries.slice(-6)) {
    const bucket = stats.get(entry.domain) || createMathDomainPerformanceBucket(entry.domain)
    bucket.recentTotal += 1
    if (entry.correct) bucket.recentCorrect += 1
    stats.set(entry.domain, bucket)
  }

  return stats
}

function rankMathDomainsForPractice(progress) {
  const stats = collectMathDomainPerformance(progress)
  return MATH_DOMAIN_KEYS.map((domain) => {
    const bucket = stats.get(domain) || createMathDomainPerformanceBucket(domain)
    const accuracy = bucket.total ? bucket.correct / bucket.total : 0.35
    const recentAccuracy = bucket.recentTotal ? bucket.recentCorrect / bucket.recentTotal : accuracy
    const coveragePenalty = bucket.practiceTotal === 0 ? 0.12 : 0
    const score = accuracy * 0.55 + recentAccuracy * 0.45 - coveragePenalty

    return {
      ...bucket,
      accuracy,
      recentAccuracy,
      score,
    }
  }).sort(
    (left, right) =>
      left.score - right.score ||
      left.practiceTotal - right.practiceTotal ||
      left.total - right.total ||
      MATH_DOMAIN_KEYS.indexOf(left.domain) - MATH_DOMAIN_KEYS.indexOf(right.domain)
  )
}

function getMathFocusDomains(progress, count = 2) {
  return rankMathDomainsForPractice(progress)
    .slice(0, Math.max(1, count))
    .map((entry) => entry.domain)
}

function selectAdaptiveMathDomain(progress) {
  const ranked = rankMathDomainsForPractice(progress)
  const lastPracticeDomain =
    [...(progress?.answerHistory || [])]
      .reverse()
      .find((entry) => entry?.phase === "practice" && MATH_DOMAIN_KEYS.includes(entry?.domain))?.domain || ""

  const weakPool = ranked.filter(
    (entry) => entry.practiceTotal === 0 || entry.accuracy < 0.75 || entry.recentAccuracy < 0.7
  )
  const preferredEntry =
    weakPool.find((entry) => entry.domain !== lastPracticeDomain) ||
    weakPool[0] ||
    ranked.find((entry) => entry.domain !== lastPracticeDomain) ||
    ranked[0]

  return preferredEntry?.domain || ""
}

function generateAdaptivePracticeTask(progress) {
  const targetLevel = normalizeMathLevel(progress?.targetLevel || progress?.placementLevel || MATH_LEVELS[1])
  const difficulty = clampMathDifficulty(progress?.practiceDifficulty || 2)
  const preferredDomain = selectAdaptiveMathDomain(progress)
  return cloneMathTask(generateMathTaskForLevel(targetLevel, difficulty, "practice", preferredDomain))
}

function evaluateMathTask(task, rawAnswer) {
  const candidate = parseMathAnswer(rawAnswer)
  const expected = Number(task?.answer)
  const tolerance = Math.max(0, Number(task?.tolerance) || 0)
  const correct = candidate !== null && Math.abs(candidate - expected) <= tolerance

  return {
    candidate,
    correct,
    expected,
  }
}

function buildChildFriendlyMathExplanation(task, expectedAnswer) {
  return [
    "Kijk rustig stap voor stap.",
    task?.hint ? `Tip: ${String(task.hint).trim()}.` : "",
    task?.explanation ? String(task.explanation).trim() : "",
    expectedAnswer ? `Dus het goede antwoord is ${expectedAnswer}.` : "",
  ]
    .filter(Boolean)
    .join(" ")
}

function appendMathAnswerHistory(progress, entry) {
  const existing = Array.isArray(progress?.answerHistory) ? progress.answerHistory : []
  progress.answerHistory = [...existing, entry].slice(-MAX_MATH_ANSWER_HISTORY)
}

function getMathAnsweredCount(progress) {
  return (Array.isArray(progress?.intakeAnswers) ? progress.intakeAnswers.length : 0) + (Number(progress?.practiceQuestionCount) || 0)
}

function getMathCorrectCount(progress) {
  const intakeCorrectCount = (Array.isArray(progress?.intakeAnswers) ? progress.intakeAnswers : []).filter((entry) => entry.correct).length
  return intakeCorrectCount + (Number(progress?.practiceCorrectCount) || 0)
}

function getMathWrongCount(progress) {
  return Math.max(0, getMathAnsweredCount(progress) - getMathCorrectCount(progress))
}

function getMathAccuracyRate(progress) {
  const total = getMathAnsweredCount(progress)
  if (!total) return 0
  return Math.round((getMathCorrectCount(progress) / total) * 100)
}

function getMathWorkLabel(progress) {
  const totalAnswered = getMathAnsweredCount(progress)
  if (!totalAnswered) return "Nog niet gestart"

  const lastAnsweredAt = progress?.lastAnsweredAt ? new Date(progress.lastAnsweredAt).getTime() : 0
  const age = lastAnsweredAt ? Date.now() - lastAnsweredAt : Number.POSITIVE_INFINITY

  if (age <= MATH_ACTIVE_WINDOW_MS && totalAnswered >= 8) return "Heel actief"
  if (age <= MATH_ACTIVE_WINDOW_MS && totalAnswered >= 3) return "Actief"
  if (age <= MATH_STALE_WINDOW_MS) return "Bezig"
  return "Stilgevallen"
}

function getMathAssignmentStatus(mathState, progress) {
  const totalAnswered = getMathAnsweredCount(progress)
  const targetPracticeQuestionCount = Math.max(1, Number(mathState?.targetPracticeQuestionCount) || 12)
  const minimumCompletion = (mathState?.intakeQuestions?.length || 0) + targetPracticeQuestionCount
  const dueAt = mathState?.dueAt ? new Date(mathState.dueAt).getTime() : 0
  const isOverdue = Boolean(dueAt && Date.now() > dueAt)

  if (totalAnswered >= minimumCompletion) {
    return {
      key: "completed",
      label: "Ingeleverd",
      minimumCompletion,
      isOverdue,
    }
  }
  if (isOverdue) {
    return {
      key: "overdue",
      label: totalAnswered > 0 ? "Verlopen" : "Niet gestart, verlopen",
      minimumCompletion,
      isOverdue,
    }
  }
  if (totalAnswered > 0) {
    return {
      key: "in-progress",
      label: "Bezig",
      minimumCompletion,
      isOverdue,
    }
  }
  return {
    key: "open",
    label: "Open",
    minimumCompletion,
    isOverdue,
  }
}

function updateMathDifficulty(progress, correct) {
  const currentDifficulty = clampMathDifficulty(progress.practiceDifficulty || 2)
  const currentStreak = Number(progress.streak) || 0
  const nextStreak = correct ? Math.max(1, currentStreak + 1) : Math.min(-1, currentStreak - 1)

  let nextDifficulty = currentDifficulty
  if (nextStreak >= 2) {
    nextDifficulty = clampMathDifficulty(currentDifficulty + 1)
  } else if (nextStreak <= -2) {
    nextDifficulty = clampMathDifficulty(currentDifficulty - 1)
  }

  progress.practiceDifficulty = nextDifficulty
  progress.streak = Math.abs(nextStreak) >= 2 ? (correct ? 0 : 0) : nextStreak
}

function sanitizeMathTask(task, viewer = "player") {
  if (!task) return null
  const clonedTask = cloneMathTask(task)
  const payload = {
    id: clonedTask.id,
    prompt: clonedTask.prompt,
    domain: clonedTask.domain,
    level: formatMathLevel(clonedTask.level),
    difficulty: clonedTask.difficulty,
    hint: clonedTask.hint,
    phase: clonedTask.phase,
  }

  if (viewer === "host") {
    return {
      ...payload,
      answer: clonedTask.answer,
      explanation: clonedTask.explanation,
      points: clonedTask.points,
    }
  }

  return payload
}

function sanitizeMathState(room, viewer = "host", playerId = "") {
  if (!room?.math?.selectedBand) return null

  if (viewer === "player") {
    const progress = playerId ? ensureMathProgress(room, playerId) : null
    const activePlayer = playerId ? room.players.find((player) => player.id === playerId) || null : null
    const growthRecord = activePlayer ? getMathGrowthSummary(activePlayer.name, activePlayer.learnerCode) : null
    const assignmentStatus = getMathAssignmentStatus(room.math, progress)
    return {
      title: room.math.title,
      assignmentTitle: room.math.assignmentTitle || room.math.title,
      dueAt: room.math.dueAt || "",
      classId: room.math.classId || "",
      className: room.math.className || "",
      targetPracticeQuestionCount: Math.max(1, Number(room.math.targetPracticeQuestionCount) || 12),
      selectedBand: formatMathLevel(room.math.selectedBand),
      learnerCode: activePlayer?.learnerCode || "",
      phase: progress?.phase || "intake",
      intakeIndex: Number(progress?.intakeIndex) || 0,
      intakeTotal: room.math.intakeQuestions.length,
      intakeAnswers: Array.isArray(progress?.intakeAnswers)
        ? progress.intakeAnswers.map((entry) => ({
            level: normalizeMathLevel(entry?.level),
            domain: MATH_DOMAIN_KEYS.includes(entry?.domain) ? entry.domain : "",
            correct: Boolean(entry?.correct),
          }))
        : [],
      placementLevel: progress?.placementLevel ? formatMathLevel(progress.placementLevel) : "",
      targetLevel: progress?.targetLevel ? formatMathLevel(progress.targetLevel) : "",
      practiceDifficulty: clampMathDifficulty(progress?.practiceDifficulty || 2),
      streak: Number(progress?.streak) || 0,
      answeredCount: getMathAnsweredCount(progress),
      correctCount: getMathCorrectCount(progress),
      wrongCount: getMathWrongCount(progress),
      accuracyRate: getMathAccuracyRate(progress),
      focusDomains: getMathFocusDomains(progress),
      practiceQuestionCount: Number(progress?.practiceQuestionCount) || 0,
      practiceCorrectCount: Number(progress?.practiceCorrectCount) || 0,
      practiceHistory: Array.isArray(progress?.answerHistory)
        ? progress.answerHistory
            .filter((entry) => entry?.phase === "practice")
            .map((entry) => ({
              domain: MATH_DOMAIN_KEYS.includes(entry?.domain) ? entry.domain : "",
              correct: Boolean(entry?.correct),
              difficulty: clampMathDifficulty(entry?.difficulty),
            }))
        : [],
      currentTask: sanitizeMathTask(progress?.currentTask, "player"),
      awaitingNext: Boolean(progress?.awaitingNext),
      lastResult: progress?.lastResult
        ? {
            ...progress.lastResult,
            placementLevel: progress.lastResult.placementLevel
              ? formatMathLevel(progress.lastResult.placementLevel)
              : "",
            targetLevel: progress.lastResult.targetLevel ? formatMathLevel(progress.lastResult.targetLevel) : "",
          }
        : null,
      growthSummary: growthRecord,
      assignmentStatus,
      updatedAt: progress?.updatedAt || null,
    }
  }

  const playerRows = room.players.map((player) => {
    const progress = room.math.playerProgress.get(player.id) || null
    const growthRecord = getMathGrowthSummary(player.name, player.learnerCode)
    const assignmentStatus = getMathAssignmentStatus(room.math, progress)
    return {
      playerId: player.id,
      learnerCode: player.learnerCode || "",
      name: player.name,
      connected: player.connected !== false,
      classId: player.classId || "",
      className: player.className || "",
      growthSummary: growthRecord,
      assignmentStatus,
      placementLevel: progress?.placementLevel ? formatMathLevel(progress.placementLevel) : "",
      targetLevel: progress?.targetLevel ? formatMathLevel(progress.targetLevel) : "",
      phase: progress?.phase || "intake",
      practiceDifficulty: clampMathDifficulty(progress?.practiceDifficulty || 2),
      answeredCount: getMathAnsweredCount(progress),
      correctCount: getMathCorrectCount(progress),
      wrongCount: getMathWrongCount(progress),
      accuracyRate: getMathAccuracyRate(progress),
      focusDomains: getMathFocusDomains(progress),
      workLabel: getMathWorkLabel(progress),
      practiceQuestionCount: Number(progress?.practiceQuestionCount) || 0,
      practiceCorrectCount: Number(progress?.practiceCorrectCount) || 0,
      awaitingNext: Boolean(progress?.awaitingNext),
      currentTask: sanitizeMathTask(progress?.currentTask, "host"),
      answerHistory: Array.isArray(progress?.answerHistory)
        ? progress.answerHistory.map((entry) => ({
            ...entry,
            level: entry?.level ? formatMathLevel(entry.level) : "",
          }))
        : [],
      lastAnsweredAt: progress?.lastAnsweredAt || null,
    }
  })

  return {
    title: room.math.title,
    assignmentTitle: room.math.assignmentTitle || room.math.title,
    dueAt: room.math.dueAt || "",
    classId: room.math.classId || "",
    className: room.math.className || "",
    targetPracticeQuestionCount: Math.max(1, Number(room.math.targetPracticeQuestionCount) || 12),
    selectedBand: formatMathLevel(room.math.selectedBand),
    intakeTotal: room.math.intakeQuestions.length,
    playerCount: playerRows.length,
    intakeCount: playerRows.filter((player) => player.phase === "intake").length,
    practiceCount: playerRows.filter((player) => player.phase === "practice").length,
    players: playerRows,
  }
}

function serializeMathState(mathState) {
  if (!mathState?.selectedBand) {
    return {
      title: "",
      assignmentTitle: "",
      dueAt: "",
      classId: "",
      className: "",
      targetPracticeQuestionCount: 12,
      selectedBand: "",
      intakeQuestions: [],
      playerProgress: [],
      startedAt: null,
      updatedAt: null,
    }
  }
  return {
    title: mathState.title,
    assignmentTitle: String(mathState.assignmentTitle || "").trim(),
    dueAt: normalizeIsoDateTime(mathState.dueAt),
    classId: String(mathState.classId || "").trim(),
    className: String(mathState.className || "").trim(),
    targetPracticeQuestionCount: Math.max(1, Number(mathState.targetPracticeQuestionCount) || 12),
    selectedBand: normalizeMathLevel(mathState.selectedBand),
    intakeQuestions: (mathState.intakeQuestions || []).map(cloneMathTask).filter(Boolean),
    playerProgress: [...(mathState.playerProgress || new Map()).entries()].map(([playerId, progress]) => [
      String(playerId),
      {
        ...progress,
        currentTask: cloneMathTask(progress?.currentTask),
        answerHistory: Array.isArray(progress?.answerHistory)
          ? progress.answerHistory.map((entry) => ({
              ...entry,
              level: normalizeMathLevel(entry?.level),
            }))
          : [],
      },
    ]),
    startedAt: mathState.startedAt || null,
    updatedAt: mathState.updatedAt || null,
  }
}

function deserializeMathState(rawMathState) {
  if (!rawMathState || !rawMathState.selectedBand) return createEmptyMathState()
  return {
    title: String(rawMathState.title ?? `Rekenroute ${formatMathLevel(rawMathState.selectedBand)}`),
    assignmentTitle: String(rawMathState.assignmentTitle ?? rawMathState.title ?? "").trim(),
    dueAt: normalizeIsoDateTime(rawMathState.dueAt),
    classId: String(rawMathState.classId ?? "").trim(),
    className: String(rawMathState.className ?? "").trim(),
    targetPracticeQuestionCount: Math.max(1, Number(rawMathState.targetPracticeQuestionCount) || 12),
    selectedBand: normalizeMathLevel(rawMathState.selectedBand),
    intakeQuestions: Array.isArray(rawMathState.intakeQuestions)
      ? rawMathState.intakeQuestions.map(cloneMathTask).filter(Boolean)
      : [],
    playerProgress: new Map(
      Array.isArray(rawMathState.playerProgress)
        ? rawMathState.playerProgress.map(([playerId, progress]) => [
            String(playerId),
            {
              playerId: String(playerId),
              phase: String(progress?.phase ?? "intake"),
              intakeIndex: Number(progress?.intakeIndex) || 0,
              intakeAnswers: Array.isArray(progress?.intakeAnswers)
                ? progress.intakeAnswers.map((entry) => ({
                    questionId: String(entry?.questionId ?? ""),
                    level: normalizeMathLevel(entry?.level),
                    domain: MATH_DOMAIN_KEYS.includes(entry?.domain) ? entry.domain : "",
                    correct: Boolean(entry?.correct),
                  }))
                : [],
              intakeRetryTaskId: String(progress?.intakeRetryTaskId ?? ""),
              answerHistory: Array.isArray(progress?.answerHistory)
                ? progress.answerHistory.map((entry) => ({
                    ...entry,
                    level: normalizeMathLevel(entry?.level),
                  }))
                : [],
              placementLevel: progress?.placementLevel ? normalizeMathLevel(progress.placementLevel) : "",
              targetLevel: progress?.targetLevel ? normalizeMathLevel(progress.targetLevel) : "",
              practiceDifficulty: clampMathDifficulty(progress?.practiceDifficulty || 2),
              streak: Number(progress?.streak) || 0,
              practiceQuestionCount: Number(progress?.practiceQuestionCount) || 0,
              practiceCorrectCount: Number(progress?.practiceCorrectCount) || 0,
              currentTask: cloneMathTask(progress?.currentTask),
              awaitingNext: Boolean(progress?.awaitingNext),
              lastResult: progress?.lastResult
                ? {
                    ...progress.lastResult,
                    placementLevel: progress.lastResult.placementLevel
                      ? normalizeMathLevel(progress.lastResult.placementLevel)
                      : "",
                    targetLevel: progress.lastResult.targetLevel
                      ? normalizeMathLevel(progress.lastResult.targetLevel)
                      : "",
                  }
                : null,
              lastAnsweredAt: progress?.lastAnsweredAt || null,
              updatedAt: progress?.updatedAt || null,
            },
          ])
        : []
    ),
    startedAt: rawMathState.startedAt || null,
    updatedAt: rawMathState.updatedAt || null,
  }
}

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

function mimeTypeToExtension(mimeType = "") {
  const normalized = String(mimeType).toLowerCase()
  if (normalized === "image/png") return "png"
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg"
  if (normalized === "image/webp") return "webp"
  if (normalized === "image/avif") return "avif"
  if (normalized === "image/gif") return "gif"
  if (normalized === "image/svg+xml") return "svg"
  return ""
}

function sanitizeManualImageUrl(value = "") {
  const rawValue = String(value || "").trim()
  if (!rawValue) return ""
  if (rawValue.startsWith("/manual-images/")) return rawValue

  try {
    const parsed = new URL(rawValue)
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString()
    }
  } catch {
    return ""
  }

  return ""
}

function isLocalManualImageUrl(value = "") {
  return String(value || "").startsWith("/manual-images/")
}

function manualImageFilePathFromUrl(value = "") {
  if (!isLocalManualImageUrl(value)) return null
  const fileName = path.basename(String(value || ""))
  return path.join(manualImagesPath, fileName)
}

function buildImageSignature({ prompt = "", category = "", kind = "question" }) {
  return crypto
    .createHmac("sha256", imageSigningSecret)
    .update(
      JSON.stringify({
        prompt: sanitizeVisualPrompt(prompt),
        category: sanitizeVisualPrompt(category),
        kind: kind === "slide" ? "slide" : "question",
      })
    )
    .digest("hex")
}

function buildSignedImageUrl({ prompt = "", category = "", kind = "question" }) {
  const cleanPrompt = sanitizeVisualPrompt(prompt)
  if (!cleanPrompt) return ""

  const cleanCategory = sanitizeVisualPrompt(category)
  const safeKind = kind === "slide" ? "slide" : "question"
  const searchParams = new URLSearchParams({
    prompt: cleanPrompt,
    category: cleanCategory,
    kind: safeKind,
    sig: buildImageSignature({ prompt: cleanPrompt, category: cleanCategory, kind: safeKind }),
  })

  return `/api/question-image?${searchParams.toString()}`
}

function noteInvalidImageSignature(ipAddress = "unknown") {
  const now = Date.now()
  const existing = invalidImageSignatureAttempts.get(ipAddress) || []
  const recentAttempts = existing.filter((timestamp) => now - timestamp < INVALID_IMAGE_SIGNATURE_WINDOW_MS)
  recentAttempts.push(now)
  invalidImageSignatureAttempts.set(ipAddress, recentAttempts)
  return recentAttempts.length
}

function hasTooManyInvalidImageSignatures(ipAddress = "unknown") {
  const now = Date.now()
  const recentAttempts = (invalidImageSignatureAttempts.get(ipAddress) || []).filter(
    (timestamp) => now - timestamp < INVALID_IMAGE_SIGNATURE_WINDOW_MS
  )
  if (recentAttempts.length) {
    invalidImageSignatureAttempts.set(ipAddress, recentAttempts)
  } else {
    invalidImageSignatureAttempts.delete(ipAddress)
  }
  return recentAttempts.length >= INVALID_IMAGE_SIGNATURE_LIMIT
}

function saveManualImageFromDataUrl({ dataUrl = "", entityId = "slide" }) {
  const match = String(dataUrl).match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i)
  if (!match) {
    throw new Error("Uploadbestand heeft geen geldig afbeeldingsformaat.")
  }

  const mimeType = match[1].toLowerCase()
  const extension = mimeTypeToExtension(mimeType)
  if (!extension) {
    throw new Error("Alleen PNG, JPG, WEBP, GIF of SVG worden ondersteund.")
  }

  const imageBuffer = Buffer.from(match[2], "base64")
  if (!imageBuffer.length) {
    throw new Error("De geuploade afbeelding is leeg.")
  }
  if (imageBuffer.length > MAX_MANUAL_IMAGE_BYTES) {
    throw new Error("De afbeelding is te groot. Gebruik een bestand tot 4 MB.")
  }

  ensureManualImagesDir()
  const fileName = `${String(entityId || "slide").replace(/[^a-z0-9-_]/gi, "-")}-${Date.now().toString(36)}.${extension}`
  const filePath = path.join(manualImagesPath, fileName)
  fs.writeFileSync(filePath, imageBuffer)
  return `/manual-images/${fileName}`
}

function saveManualImageFromBuffer({ imageBuffer, mimeType = "image/jpeg", entityId = "slide" }) {
  const extension = mimeTypeToExtension(mimeType)
  if (!extension) {
    throw new Error("Er is geen ondersteund afbeeldingsformaat gevonden.")
  }
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    throw new Error("De gevonden afbeelding is leeg.")
  }
  if (imageBuffer.length > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error("De gevonden afbeelding is te groot. Gebruik maximaal 5 MB.")
  }

  ensureManualImagesDir()
  const fileName = `${String(entityId || "slide").replace(/[^a-z0-9-_]/gi, "-")}-${Date.now().toString(36)}.${extension}`
  const filePath = path.join(manualImagesPath, fileName)
  fs.writeFileSync(filePath, imageBuffer)
  return `/manual-images/${fileName}`
}

async function saveManualImageFromRemoteUrl({ imageUrl = "", entityId = "slide" }) {
  const normalizedUrl = sanitizeManualImageUrl(imageUrl)
  if (!normalizedUrl || isLocalManualImageUrl(normalizedUrl)) return normalizedUrl

  const response = await fetchWithTimeout(normalizedUrl, {}, REMOTE_MANUAL_IMAGE_TIMEOUT_MS)
  if (!response.ok) {
    throw new Error(`De afbeelding kon niet worden opgehaald (${response.status}).`)
  }

  const mimeType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
  const extension = mimeTypeToExtension(mimeType)
  if (!extension) {
    throw new Error("De link verwijst niet naar een ondersteunde afbeelding.")
  }

  const declaredLength = Number(response.headers.get("content-length") || 0)
  if (declaredLength > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error("De afbeelding achter de link is te groot. Gebruik maximaal 5 MB.")
  }

  const imageBuffer = Buffer.from(await response.arrayBuffer())
  if (!imageBuffer.length) {
    throw new Error("De afbeelding achter de link is leeg.")
  }
  if (imageBuffer.length > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error("De afbeelding achter de link is te groot. Gebruik maximaal 5 MB.")
  }

  ensureManualImagesDir()
  const fileName = `${String(entityId || "slide").replace(/[^a-z0-9-_]/gi, "-")}-${Date.now().toString(36)}.${extension}`
  const filePath = path.join(manualImagesPath, fileName)
  fs.writeFileSync(filePath, imageBuffer)
  return `/manual-images/${fileName}`
}

function collectManualImageUrlsFromQuestions(questions = []) {
  return (questions || [])
    .map((question) => sanitizeManualImageUrl(question?.manualImageUrl || ""))
    .filter(Boolean)
}

function buildQuestionSearchPrompt(question = {}, room = null) {
  return [
    room?.game?.topic || "",
    question?.category || "",
    question?.imageAlt || "",
    question?.imagePrompt || "",
    question?.prompt || question?.question_text || "",
    ...(Array.isArray(question?.options) ? question.options : []),
  ]
    .filter(Boolean)
    .join(" ")
    .trim()
}

function buildQuestionSearchCategory(question = {}, room = null) {
  return [
    room?.game?.topic || "",
    question?.category || "",
    room?.game?.source === "practice" ? "oefentoets" : room?.game?.mode || "",
  ]
    .filter(Boolean)
    .join(" ")
    .trim()
}

function stripHtmlTags(value = "") {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizePublicImageSearchQuery(value = "") {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "the",
    "about",
    "with",
    "without",
    "create",
    "classroom",
    "slide",
    "illustration",
    "image",
    "photo",
    "realistic",
    "polished",
    "modern",
    "cinematic",
    "lighting",
    "visual",
    "subject",
    "scene",
    "show",
    "clear",
    "natural",
    "depth",
    "style",
    "one",
    "for",
    "of",
    "in",
    "on",
    "to",
    "or",
    "de",
    "het",
    "een",
    "met",
    "zonder",
    "van",
    "voor",
    "naar",
    "bij",
    "uit",
    "over",
    "onder",
    "tussen",
    "waar",
    "welke",
    "welk",
    "wat",
    "hoe",
    "waarom",
    "wanneer",
    "wie",
    "ligt",
    "liggen",
    "precies",
    "ongeveer",
    "dia",
    "les",
    "leerlingen",
    "studenten",
    "opdracht",
    "bekijk",
    "bekijken",
    "kijk",
    "kijken",
    "toon",
    "toont",
    "kaartje",
    "afbeelding",
    "plaatje",
    "conclusie",
    "summary",
    "summarize",
    "samenvatting",
    "slot",
    "afsluiting",
    "intro",
    "introduction",
    "inleiding",
    "overzicht",
    "basis",
    "presentatie",
    "ontdekken",
  ])

  const tokens = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f\s-]/gi, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => token.length > 2 && !stopWords.has(token))

  return [...new Set(tokens)].slice(0, 8).join(" ")
}

function tokenizePublicImageText(value = "") {
  return normalizePublicImageSearchQuery(value)
    .split(/\s+/)
    .filter(Boolean)
}

function normalizeSearchPhrase(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f\s-]/gi, " ")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

const PUBLIC_IMAGE_CONTEXT_STOPWORDS = new Set([
  "conclusie",
  "summary",
  "samenvatting",
  "slot",
  "afsluiting",
  "intro",
  "introduction",
  "inleiding",
  "presentatie",
  "slide",
  "dia",
  "lesson",
  "les",
  "opdracht",
  "uitleg",
  "basis",
  "overzicht",
  "live",
  "vraag",
  "vragen",
  "antwoord",
  "antwoorden",
  "kijk",
  "kijken",
  "bekijk",
  "bekijken",
  "toon",
  "toont",
  "noem",
  "vertel",
  "leg",
  "uit",
])

const PUBLIC_IMAGE_CANDIDATE_NOISE_TOKENS = new Set([
  "museum",
  "collection",
  "commons",
  "wikimedia",
  "photo",
  "image",
  "images",
  "visual",
  "thumbnail",
  "public",
  "domain",
  "creative",
  "license",
  "source",
  "pagina",
  "page",
  "object",
  "objects",
  "archive",
  "archief",
  "title",
  "description",
  "historic",
  "history",
])

const PUBLIC_IMAGE_SHORT_TOKENS = new Set([
  "map",
  "sea",
  "war",
  "art",
  "law",
  "god",
  "sun",
  "moon",
])

function splitReusableImageSearchClauses(values = []) {
  const clauses = []
  for (const value of Array.isArray(values) ? values : [values]) {
    const rawClauses = String(value || "")
      .split(/[\n\r.!?;:]+/)
      .map((part) => normalizeSearchPhrase(part))
      .filter(Boolean)
    clauses.push(...rawClauses)
  }
  return [...new Set(clauses)]
}

function buildReusableImageAnchorPhrases({ prompt = "", category = "" }) {
  const rawSegments = [
    ...splitReusableImageSearchClauses([category, prompt]),
    ...[category, prompt].map((value) => String(value || "").trim()).filter(Boolean),
  ]
  const phraseMeta = new Map()

  for (const segment of rawSegments) {
    const normalized = normalizeSearchPhrase(segment)
    if (!normalized) continue
    const words = normalized
      .split(/\s+/)
      .filter(Boolean)
      .filter((word) => !PUBLIC_IMAGE_CONTEXT_STOPWORDS.has(word))

    if (!words.length) continue

    const maxWindow = Math.min(words.length, 5)
    for (let size = maxWindow; size >= 2; size -= 1) {
      for (let index = 0; index <= words.length - size; index += 1) {
        const phrase = words.slice(index, index + size).join(" ").trim()
        if (phrase.length < 6) continue
        const longWordCount = phrase.split(/\s+/).filter((word) => word.length >= 5).length
        const quality = size * 4 + longWordCount * 2 - index
        const previousQuality = phraseMeta.get(phrase)?.quality || -Infinity
        if (quality > previousQuality) {
          phraseMeta.set(phrase, { phrase, quality })
        }
      }
    }

    const leadingPhrase = words.slice(0, Math.min(words.length, 4)).join(" ").trim()
    if (leadingPhrase.length >= 6) {
      const quality = leadingPhrase.split(/\s+/).length * 4 + 3
      const previousQuality = phraseMeta.get(leadingPhrase)?.quality || -Infinity
      if (quality > previousQuality) {
        phraseMeta.set(leadingPhrase, { phrase: leadingPhrase, quality })
      }
    }
  }

  return [...phraseMeta.values()]
    .sort((left, right) => right.quality - left.quality)
    .map((entry) => entry.phrase)
    .slice(0, 10)
}

function expandReusableImageTokens(tokens = []) {
  const aliasMap = new Map([
    ["city", ["stad", "steden", "cities", "capital", "hoofdstad"]],
    ["stad", ["city", "cities", "capital", "hoofdstad"]],
    ["steden", ["city", "cities"]],
    ["cities", ["city", "stad", "steden"]],
    ["country", ["land", "nation"]],
    ["land", ["country", "nation"]],
    ["capital", ["hoofdstad", "city", "stad"]],
    ["hoofdstad", ["capital", "city", "stad"]],
    ["woestijn", ["desert"]],
    ["desert", ["woestijn"]],
    ["bergen", ["mountains", "mountain", "berg"]],
    ["berg", ["mountain", "mountains", "bergen"]],
    ["mountain", ["berg", "bergen", "mountains"]],
    ["mountains", ["berg", "bergen", "mountain"]],
    ["plein", ["square", "market", "markt"]],
    ["square", ["plein", "market", "markt"]],
    ["markt", ["market", "plein", "square"]],
    ["market", ["markt", "plein", "square"]],
    ["moskee", ["mosque"]],
    ["mosque", ["moskee"]],
    ["kaart", ["map", "atlas"]],
    ["map", ["kaart"]],
    ["atlas", ["map", "kaart"]],
    ["gerecht", ["food", "dish", "meal", "cuisine"]],
    ["food", ["gerecht", "dish", "meal", "cuisine"]],
    ["dish", ["gerecht", "food", "meal"]],
    ["portret", ["portrait"]],
    ["portrait", ["portret"]],
    ["keizer", ["emperor"]],
    ["emperor", ["keizer"]],
    ["koning", ["king"]],
    ["king", ["koning"]],
    ["koningin", ["queen"]],
    ["queen", ["koningin"]],
    ["senaat", ["senate"]],
    ["senate", ["senaat"]],
  ])

  const expanded = new Set(tokens)
  for (const token of tokens) {
    const aliases = aliasMap.get(token) || []
    for (const alias of aliases) expanded.add(alias)
  }
  return [...expanded]
}

function buildReusableImageTokenVariants(token = "") {
  const base = normalizeSearchPhrase(token)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!base) return []

  const variants = new Set([base])
  const compact = base.replace(/\s+/g, "")
  if (compact && compact !== base) variants.add(compact)

  const endings = ["s", "es", "en", "e", "er", "ers"]
  for (const value of [base, compact]) {
    if (!value) continue
    for (const ending of endings) {
      if (value.length > ending.length + 3 && value.endsWith(ending)) {
        variants.add(value.slice(0, -ending.length))
      }
    }
  }

  return [...variants]
}

function mergeReusableImageAnchorTokens(tokens = [], limit = 24) {
  const merged = []
  const seen = new Set()

  for (const token of Array.isArray(tokens) ? tokens : [tokens]) {
    const baseToken = normalizeSearchPhrase(token)
    if (!baseToken) continue

    const expansionInputs = [baseToken, ...buildReusableImageTokenVariants(baseToken)]
    const expandedTokens = expandReusableImageTokens(expansionInputs)
      .flatMap((value) => buildReusableImageTokenVariants(value))
      .map((value) => normalizeSearchPhrase(value))
      .filter(Boolean)

    for (const expandedToken of expandedTokens) {
      if (
        seen.has(expandedToken) ||
        PUBLIC_IMAGE_CONTEXT_STOPWORDS.has(expandedToken) ||
        (expandedToken.length < 4 && !/\d/.test(expandedToken) && !PUBLIC_IMAGE_SHORT_TOKENS.has(expandedToken))
      ) {
        continue
      }
      seen.add(expandedToken)
      merged.push(expandedToken)
      if (merged.length >= limit) return merged
    }
  }

  return merged
}

function buildReusableImageAnchorTokens({ prompt = "", category = "" }) {
  const baseTokens = tokenizePublicImageText([category, prompt].filter(Boolean).join(" "))
  const phraseTokens = tokenizePublicImageText(buildReusableImageAnchorPhrases({ prompt, category }).join(" "))
  const meaningfulTokens = baseTokens.filter(
    (token) => token.length >= 4 || /\d/.test(token) || PUBLIC_IMAGE_SHORT_TOKENS.has(token)
  )
  return mergeReusableImageAnchorTokens([...meaningfulTokens, ...phraseTokens], 18)
}

function buildReusableImageQueryAnchorPhrases({ prompt = "", category = "", searchQueries = [] }) {
  return [
    ...new Set(
      [
        ...buildReusableImageAnchorPhrases({ prompt, category }),
        ...(Array.isArray(searchQueries) ? searchQueries : []),
      ]
        .map((phrase) => normalizeSearchPhrase(phrase))
        .filter((phrase) => phrase && phrase.length >= 6)
    ),
  ].slice(0, 12)
}

function buildReusableImageQueryAnchorTokens({ prompt = "", category = "", searchQueries = [] }) {
  const queryTokens = (Array.isArray(searchQueries) ? searchQueries : [])
    .flatMap((query) => tokenizePublicImageText(query))
    .filter((token) => token.length >= 4 || /\d/.test(token))
  return mergeReusableImageAnchorTokens(
    [...buildReusableImageAnchorTokens({ prompt, category }), ...queryTokens],
    24
  )
}

function inferReusableImageIntent({ prompt = "", category = "", anchorTokens = [], anchorPhrases = [] }) {
  const source = normalizeSearchPhrase([prompt, category, ...anchorPhrases, ...anchorTokens].join(" "))
  const has = (pattern) => pattern.test(source)

  return {
    isPlace: has(/\b(city|stad|steden|capital|hoofdstad|country|land|plein|square|market|markt|mosque|moskee|street|straat|landscape|desert|woestijn|mountain|berg|bergen|river|rivier|sea|zee|ocean|kust|region|regio|village|dorp|landmark|map|kaart|atlas)\b/),
    isPerson: has(/\b(person|persoon|portrait|portret|leader|leider|emperor|keizer|king|koning|queen|koningin|philosopher|filosoof|scientist|wetenschapper|writer|schrijver|poet|dichter|biografie|biography)\b/),
    isHistoric: has(/\b(history|geschiedenis|historisch|historie|ancient|oudheid|romein|middeleeuw|war|oorlog|battle|slag|treaty|verdrag|revolution|revolutie|empire|rijk|dynasty|dynastie)\b/),
    isFood: has(/\b(food|eten|gerecht|dish|meal|cuisine|keuken|recipe|recept|drink|drank)\b/),
    isMap: has(/\b(map|kaart|plattegrond|atlas|cartography|cartografie)\b/),
    isNature: has(/\b(animal|dier|forest|bos|tree|boom|landscape|natuur|desert|woestijn|mountain|berg|river|rivier|sea|zee|ocean|natuurgebied|plant|bloem)\b/),
  }
}

function buildReusableImageTokenIndex(tokens = []) {
  const index = new Set()
  for (const token of Array.isArray(tokens) ? tokens : [tokens]) {
    const expansions = mergeReusableImageAnchorTokens([token], 12)
    for (const expansion of expansions) {
      index.add(expansion)
    }
  }
  return index
}

function hasReusableTokenMatch(token = "", candidateTokenIndex = new Set()) {
  const normalizedToken = normalizeSearchPhrase(token)
  if (!normalizedToken) return false
  const variants = mergeReusableImageAnchorTokens([normalizedToken], 12)
  return variants.some((variant) => candidateTokenIndex.has(variant))
}

function buildReusableImageTokenQueryCombos(anchorTokens = []) {
  const tokens = anchorTokens.filter((token) => token.length >= 4 || /\d/.test(token)).slice(0, 6)
  if (!tokens.length) return []

  const combos = [
    tokens.slice(0, 2).join(" "),
    tokens.slice(0, 3).join(" "),
    tokens.slice(-2).join(" "),
    tokens.slice(-3).join(" "),
    [tokens[0], tokens[2], tokens[3]].filter(Boolean).join(" "),
  ]

  return [...new Set(combos.map((value) => normalizePublicImageSearchQuery(value)).filter(Boolean))].slice(0, 5)
}

function scoreReusableImageCandidate(entry, anchorTokens = [], anchorPhrases = [], imageIntent = {}) {
  const rawText = [entry?.title, entry?.description, entry?.sourceUrl]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  const normalizedRawText = normalizeSearchPhrase(rawText)
  const candidateTokens = tokenizePublicImageText(rawText)
  const candidateTokenIndex = buildReusableImageTokenIndex(candidateTokens)
  const anchorTokenIndex = buildReusableImageTokenIndex(anchorTokens)
  const matchedAnchorTokens = anchorTokens.filter((token) => hasReusableTokenMatch(token, candidateTokenIndex))
  const salientAnchorTokens = anchorTokens.filter((token) => token.length >= 5 || /\d/.test(token))
  const salientMatchedTokens = salientAnchorTokens.filter((token) => hasReusableTokenMatch(token, candidateTokenIndex))

  let score = 0
  for (const token of matchedAnchorTokens) {
    score += token.length >= 6 ? 3 : 2
  }

  let phraseMatches = 0
  for (const phrase of anchorPhrases) {
    const normalizedPhrase = normalizeSearchPhrase(phrase)
    if (!normalizedPhrase) continue
    if (!normalizedRawText.includes(normalizedPhrase)) continue
    phraseMatches += 1
    score += normalizedPhrase.split(/\s+/).length >= 3 ? 8 : 5
  }

  if (anchorPhrases.length > 0 && phraseMatches === 0) {
    score -= 4
  }

  if (salientAnchorTokens.length >= 3 && salientMatchedTokens.length === 0 && phraseMatches === 0) {
    score -= 14
  } else if (salientAnchorTokens.length >= 4 && salientMatchedTokens.length <= 1 && phraseMatches === 0) {
    score -= 6
  }

  const candidateSalientNoise = [...new Set(candidateTokens)]
    .filter((token) => token.length >= 5)
    .filter((token) => !PUBLIC_IMAGE_CANDIDATE_NOISE_TOKENS.has(token))
    .filter((token) => !hasReusableTokenMatch(token, anchorTokenIndex))
  if (candidateSalientNoise.length >= 6 && salientMatchedTokens.length <= 1 && phraseMatches === 0) {
    score -= Math.min(10, Math.ceil(candidateSalientNoise.length / 2))
  }

  if (/(comparative heights|principal mountains|north america|south america|world|continents?)/i.test(rawText)) {
    score -= 8
  }

  if (
    imageIntent.isPlace &&
    !imageIntent.isHistoric &&
    !imageIntent.isPerson &&
    /(treaty|marriage|princess|prince|king|queen|court scene|auction|advertisement|brochure|hotel|real estate|stock photo)/i.test(rawText)
  ) {
    score -= 10
  }

  if (imageIntent.isMap) {
    if (/(map|atlas|cartograph|kaart|plattegrond|globe)/i.test(rawText)) {
      score += 6
    } else {
      score -= 5
    }
  }

  if (imageIntent.isPlace || imageIntent.isNature) {
    if (/(city|stad|capital|hoofdstad|square|plein|market|markt|mosque|moskee|street|straat|desert|woestijn|mountain|bergen?|landscape|skyline|coast|kust|map|kaart|landmark)/i.test(rawText)) {
      score += 4
    }
    if (
      !imageIntent.isHistoric &&
      !imageIntent.isPerson &&
      /(portrait|portret|bust|statue|sculpture|engraving|etching|court scene)/i.test(rawText)
    ) {
      score -= 6
    }
  }

  if (imageIntent.isPerson) {
    if (/(portrait|portret|bust|statue|sculpture|figure|head|coin|painting|relief)/i.test(rawText)) {
      score += 4
    }
    if (/(city|stad|landscape|mountain|woestijn|market|plein|map|kaart)/i.test(rawText)) {
      score -= 4
    }
  }

  if (imageIntent.isFood) {
    if (/(food|gerecht|dish|meal|cuisine|recipe|market|plate|restaurant|kitchen|keuken)/i.test(rawText)) {
      score += 5
    } else {
      score -= 3
    }
  }

  if (imageIntent.isHistoric) {
    if (/(history|histor|ancient|empire|battle|war|treaty|archaeolog|museum|artifact|statue|coin|relief)/i.test(rawText)) {
      score += 3
    }
  }

  if (imageIntent.isPlace || imageIntent.isNature || imageIntent.isFood || imageIntent.isMap) {
    if (entry?.source === "openverse" || entry?.source === "wikimedia-commons") score += 2
    if (entry?.source === "cleveland-museum" || entry?.source === "met-museum") score -= 2
  } else if (imageIntent.isPerson || imageIntent.isHistoric) {
    if (entry?.source === "wikimedia-commons" || entry?.source === "cleveland-museum" || entry?.source === "met-museum") {
      score += 2
    }
  }

  return score
}

function buildPublicImageSearchQueries({ prompt = "", category = "", attemptIndex = 0 }) {
  const fallback = normalizePublicImageSearchQuery([category, prompt].filter(Boolean).join(" "))
  const promptOnly = normalizePublicImageSearchQuery(prompt)
  const categoryOnly = normalizePublicImageSearchQuery(category)
  const anchorTokens = buildReusableImageAnchorTokens({ prompt, category })
  const anchorPhrases = buildReusableImageAnchorPhrases({ prompt, category })
  const clauseQueries = splitReusableImageSearchClauses([category, prompt])
    .map((value) => normalizePublicImageSearchQuery(value))
    .filter(Boolean)
  const compactAnchorQuery = normalizePublicImageSearchQuery(anchorTokens.slice(0, 5).join(" "))
  const subjectLedQuery = normalizePublicImageSearchQuery([anchorTokens[0], anchorTokens[1], anchorTokens[2]].filter(Boolean).join(" "))
  const tokenComboQueries = buildReusableImageTokenQueryCombos(anchorTokens)
  const phraseQueries = anchorPhrases.map((phrase) => normalizePublicImageSearchQuery(phrase)).filter(Boolean)
  const ordered = [
    ...new Set(
      [
        ...clauseQueries,
        ...phraseQueries,
        compactAnchorQuery,
        subjectLedQuery,
        ...tokenComboQueries,
        fallback,
        promptOnly,
        categoryOnly,
      ].filter(Boolean)
    ),
  ].slice(0, 10)
  if (!ordered.length) return []
  const safeAttemptIndex = Math.max(0, Number(attemptIndex) || 0)
  const rotation = safeAttemptIndex % ordered.length
  return [...ordered.slice(rotation), ...ordered.slice(0, rotation)]
}

async function buildAiPublicImageSearchQueries({ prompt = "", category = "", kind = "slide" }) {
  const preferredProvider = openAI ? "openai" : genAI ? "gemini" : groq ? "groq" : ""
  if (!preferredProvider) return []

  const searchPrompt = `
Maak 5 verschillende korte zoekopdrachten van 3 tot 7 Engelse kernwoorden voor een bestaande rechtenvrije afbeelding.
Context:
- type: ${kind}
- categorie: ${category || "algemeen"}
- beschrijving: ${prompt || "algemeen onderwerp"}

Regels:
- Geef precies 5 regels terug.
- Elke regel is 1 zoekopdracht.
- Alleen kernwoorden.
- Geen volledige zin.
- Geen opsommingstekens of nummers.
- Geen stijlwoorden zoals cinematic, polished, realistic of illustration.
- Variant 1: het meest directe onderwerp of de meest waarschijnlijke naam.
- Variant 2: een bredere beschrijving die een publieke beeldbank kan herkennen.
- Variant 3: een archief- of encyclopedische formulering.
- Variant 4: een alternatieve spelling, transliteratie of context.
- Variant 5: een concrete visuele insteek die nog steeds bij hetzelfde onderwerp hoort.
`

  try {
    const result = await requestProviderText(
      preferredProvider,
      searchPrompt,
      PUBLIC_IMAGE_QUERY_AI_TIMEOUT_MS,
      "Je maakt extreem korte zoekopdrachten voor rechtenvrije afbeeldingszoekmachines."
    )
    return [...new Set(
      String(result || "")
        .split(/\r?\n/)
        .map((line) => line.replace(/^[\-\d\.\)\s]+/, ""))
        .map((line) => normalizePublicImageSearchQuery(line))
        .filter(Boolean)
    )].slice(0, 6)
  } catch (error) {
    console.warn("[images] public image search query fallback:", error instanceof Error ? error.message : error)
    return []
  }
}

function isReusablePublicImageLicense(value = "") {
  const normalized = stripHtmlTags(value).toLowerCase()
  const compact = normalized.replace(/\s+/g, " ").trim()
  const isCreativeCommonsAttribution =
    (
      normalized.includes("cc by") ||
      normalized.includes("cc-by") ||
      normalized.includes("attribution") ||
      compact === "by" ||
      compact.startsWith("by ")
    ) &&
    !normalized.includes("nc") &&
    !normalized.includes("noncommercial") &&
    !normalized.includes("nd") &&
    !normalized.includes("no derivatives")

  const isCreativeCommonsShareAlike =
    (
      normalized.includes("cc by-sa") ||
      normalized.includes("cc-by-sa") ||
      normalized.includes("sharealike") ||
      compact === "by-sa" ||
      compact.startsWith("by-sa ")
    ) &&
    !normalized.includes("nc") &&
    !normalized.includes("noncommercial")

  return (
    normalized.includes("public domain") ||
    normalized.includes("cc0") ||
    normalized.includes("creative commons zero") ||
    normalized.includes("pdm") ||
    compact === "pdm" ||
    compact === "cc0" ||
    normalized.includes("no known copyright restrictions") ||
    normalized.includes("gnu free documentation") ||
    normalized.includes("gfdl") ||
    isCreativeCommonsAttribution ||
    isCreativeCommonsShareAlike
  )
}

function extractCommonsMetadataValue(metadata = {}, key = "") {
  return stripHtmlTags(metadata?.[key]?.value || "")
}

function normalizeExcludedImageValue(value = "") {
  return String(value || "").trim().toLowerCase()
}

function sanitizeImageSourceHistory(values = []) {
  const normalized = Array.isArray(values) ? values : [values]
  return [...new Set(normalized.map((value) => String(value || "").trim()).filter(Boolean))].slice(-24)
}

function buildReferenceImageCandidate({
  title = "",
  description = "",
  imageUrl = "",
  originalImageUrl = "",
  sourceUrl = "",
  license = "",
  author = "",
  searchQuery = "",
  source = "",
  anchorTokens = [],
  anchorPhrases = [],
  imageIntent = {},
}) {
  const normalizedTitle = normalizeExcludedImageValue(title)
  const normalizedSourceUrl = normalizeExcludedImageValue(sourceUrl)
  const normalizedImageUrl = normalizeExcludedImageValue(imageUrl)
  const normalizedOriginalImageUrl = normalizeExcludedImageValue(originalImageUrl)

  return {
    title: stripHtmlTags(title),
    description: stripHtmlTags(description),
    imageUrl: String(imageUrl || "").trim(),
    originalImageUrl: String(originalImageUrl || imageUrl || "").trim(),
    normalizedTitle,
    normalizedSourceUrl,
    normalizedImageUrl,
    normalizedOriginalImageUrl,
    license: String(license || "").trim(),
    author: stripHtmlTags(author),
    sourceUrl: stripHtmlTags(sourceUrl),
    searchQuery: String(searchQuery || "").trim(),
    source: String(source || "").trim(),
    score: scoreReusableImageCandidate(
      {
        title,
        description,
        sourceUrl,
        source,
      },
      anchorTokens,
      anchorPhrases,
      imageIntent
    ),
  }
}

function filterReferenceImageCandidates(candidates = [], excludedSources = new Set(), anchorTokens = [], anchorPhrases = [], imageIntent = {}) {
  const requiresStrongerMatch =
    anchorPhrases.length > 0 ||
    anchorTokens.length >= 4 ||
    imageIntent.isPlace ||
    imageIntent.isPerson ||
    imageIntent.isHistoric ||
    imageIntent.isMap ||
    imageIntent.isFood
  const minimumScore =
    imageIntent.isPlace || imageIntent.isPerson || imageIntent.isMap || imageIntent.isFood
      ? 5
      : requiresStrongerMatch
        ? 4
        : 2

  return candidates
    .filter(
      (entry) =>
        entry.imageUrl &&
        isReusablePublicImageLicense(entry.license) &&
        !excludedSources.has(entry.normalizedSourceUrl) &&
        !excludedSources.has(entry.normalizedImageUrl) &&
        !excludedSources.has(entry.normalizedOriginalImageUrl) &&
        !excludedSources.has(entry.normalizedTitle) &&
        entry.score >= minimumScore
    )
    .sort((left, right) => right.score - left.score)
}

function dedupeReferenceImageCandidates(candidates = []) {
  const seenKeys = new Set()
  const unique = []
  for (const candidate of candidates) {
    const dedupeKey =
      candidate.normalizedOriginalImageUrl ||
      candidate.normalizedImageUrl ||
      candidate.normalizedSourceUrl ||
      candidate.normalizedTitle
    if (!dedupeKey || seenKeys.has(dedupeKey)) continue
    seenKeys.add(dedupeKey)
    unique.push(candidate)
  }
  return unique
}

async function downloadReferenceImageCandidate(candidate) {
  const downloadUrls = [candidate.originalImageUrl, candidate.imageUrl].filter(Boolean)
  for (const downloadUrl of downloadUrls) {
    try {
      const imageResponse = await fetchWithTimeout(downloadUrl, {}, PUBLIC_IMAGE_DOWNLOAD_TIMEOUT_MS)
      if (!imageResponse.ok) continue

      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer())
      if (!imageBuffer.length) continue

      return {
        buffer: imageBuffer,
        contentType: String(imageResponse.headers.get("content-type") || "image/jpeg").split(";")[0].trim() || "image/jpeg",
        source: candidate.source,
        license: candidate.license,
        author: candidate.author,
        sourceUrl: candidate.sourceUrl,
        imageUrl: candidate.imageUrl,
        originalImageUrl: candidate.originalImageUrl,
        title: candidate.title,
        searchQuery: candidate.searchQuery,
      }
    } catch (error) {
      console.warn("[images] candidate download failed:", error instanceof Error ? error.message : error)
    }
  }

  return null
}

function buildOpenverseLicenseLabel(entry = {}) {
  const license = String(entry?.license || "").trim()
  const version = String(entry?.license_version || "").trim()
  return [license, version].filter(Boolean).join(" ").trim()
}

async function collectOpenverseReferenceImageCandidatesByQuery(searchQuery = "", anchorTokens = [], anchorPhrases = [], excludedSources = new Set(), attemptIndex = 0, imageIntent = {}) {
  if (!searchQuery) return null

  const pageSize = 12
  const safeAttemptIndex = Math.max(0, Number(attemptIndex) || 0)
  const page = Math.max(1, Math.floor(safeAttemptIndex / pageSize) + 1)
  const url = new URL("https://api.openverse.org/v1/images/")
  url.search = new URLSearchParams({
    q: searchQuery,
    page_size: String(pageSize),
    page: String(page),
    license: "by,by-sa,cc0,pdm",
    extension: "jpg,jpeg,png",
    mature: "false",
  }).toString()

  const response = await fetchWithTimeout(
    url.toString(),
    { headers: { accept: "application/json" } },
    PUBLIC_IMAGE_QUERY_TIMEOUT_MS
  )
  if (!response.ok) {
    throw new Error(`Openverse zoekopdracht mislukte (${response.status}).`)
  }

  const payload = await response.json()
  const results = Array.isArray(payload?.results) ? payload.results : []
  const matches = results
    .map((item) => {
      const title = stripHtmlTags(item?.title || item?.foreign_landing_url || "")
      const description = [
        stripHtmlTags(item?.creator || ""),
        stripHtmlTags(item?.source || ""),
        Array.isArray(item?.tags) ? item.tags.map((tag) => stripHtmlTags(tag?.name || tag)).join(" ") : "",
      ]
        .filter(Boolean)
        .join(" ")
      const sourceUrl = stripHtmlTags(item?.foreign_landing_url || item?.creator_url || item?.url || "")
      const imageUrl = String(item?.thumbnail || item?.url || "").trim()
      const originalImageUrl = String(item?.url || item?.thumbnail || "").trim()
      const license = buildOpenverseLicenseLabel(item)

      return buildReferenceImageCandidate({
        title,
        description,
        imageUrl,
        originalImageUrl,
        sourceUrl,
        license,
        author: item?.creator || "",
        searchQuery,
        source: "openverse",
        anchorTokens,
        anchorPhrases,
        imageIntent,
      })
    })
  const filtered = filterReferenceImageCandidates(matches, excludedSources, anchorTokens, anchorPhrases, imageIntent)
  const rotation = filtered.length ? safeAttemptIndex % filtered.length : 0
  return filtered.length ? [...filtered.slice(rotation), ...filtered.slice(0, rotation)].slice(0, 8) : []
}

async function collectWikimediaReferenceImageCandidatesByQuery(searchQuery = "", anchorTokens = [], anchorPhrases = [], excludedSources = new Set(), attemptIndex = 0, imageIntent = {}) {
  if (!searchQuery) return null

  const url = new URL("https://commons.wikimedia.org/w/api.php")
  url.search = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrnamespace: "6",
    gsrlimit: "8",
    gsrsearch: searchQuery,
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiurlwidth: "1400",
  }).toString()

  const response = await fetchWithTimeout(
    url.toString(),
    { headers: { accept: "application/json" } },
    PUBLIC_IMAGE_QUERY_TIMEOUT_MS
  )
  if (!response.ok) {
    throw new Error(`Wikimedia Commons zoekopdracht mislukte (${response.status}).`)
  }

  const payload = await response.json()
  const pages = Object.values(payload?.query?.pages || {})
  const matches = pages
    .map((page) => {
      const imageInfo = Array.isArray(page?.imageinfo) ? page.imageinfo[0] || {} : {}
      const metadata = imageInfo?.extmetadata || {}
      const license =
        extractCommonsMetadataValue(metadata, "LicenseShortName") ||
        extractCommonsMetadataValue(metadata, "License") ||
        extractCommonsMetadataValue(metadata, "UsageTerms")
      const author = extractCommonsMetadataValue(metadata, "Artist")
      const sourceUrl = stripHtmlTags(imageInfo?.descriptionurl || imageInfo?.descriptionshorturl || "")
      const description =
        extractCommonsMetadataValue(metadata, "ImageDescription") ||
        extractCommonsMetadataValue(metadata, "ObjectName") ||
        extractCommonsMetadataValue(metadata, "Categories")
      const normalizedTitle = normalizeExcludedImageValue(page?.title || "")
      const normalizedSourceUrl = normalizeExcludedImageValue(sourceUrl)
      const normalizedImageUrl = normalizeExcludedImageValue(imageInfo?.thumburl || imageInfo?.url || "")
      const normalizedOriginalImageUrl = normalizeExcludedImageValue(imageInfo?.url || "")

      return buildReferenceImageCandidate({
        title: page?.title || "",
        description,
        imageUrl: imageInfo?.thumburl || imageInfo?.url || "",
        originalImageUrl: imageInfo?.url || "",
        sourceUrl,
        license,
        author,
        searchQuery,
        source: "wikimedia-commons",
        anchorTokens,
        anchorPhrases,
        imageIntent,
      })
    })
  const candidates = filterReferenceImageCandidates(matches, excludedSources, anchorTokens, anchorPhrases, imageIntent).slice(0, 8)
  const safeAttemptIndex = Math.max(0, Number(attemptIndex) || 0)
  const rotation = candidates.length ? safeAttemptIndex % candidates.length : 0
  return candidates.length ? [...candidates.slice(rotation), ...candidates.slice(0, rotation)] : []
}

async function collectClevelandReferenceImageCandidatesByQuery(searchQuery = "", anchorTokens = [], anchorPhrases = [], excludedSources = new Set(), attemptIndex = 0, imageIntent = {}) {
  if (!searchQuery) return []

  const pageSize = 12
  const safeAttemptIndex = Math.max(0, Number(attemptIndex) || 0)
  const skip = Math.floor(safeAttemptIndex / pageSize) * pageSize
  const url = new URL("https://openaccess-api.clevelandart.org/api/artworks/")
  url.search = new URLSearchParams({
    q: searchQuery,
    cc0: "1",
    has_image: "1",
    limit: String(pageSize),
    skip: String(skip),
    fields: "title,url,description,images,share_license_status,creators,culture,type,department",
  }).toString()

  const response = await fetchWithTimeout(
    url.toString(),
    { headers: { accept: "application/json" } },
    PUBLIC_IMAGE_QUERY_TIMEOUT_MS
  )
  if (!response.ok) {
    throw new Error(`Cleveland Museum API zoekopdracht mislukte (${response.status}).`)
  }

  const payload = await response.json()
  const results = Array.isArray(payload?.data) ? payload.data : []
  const matches = results
    .map((item) => {
      const imageUrl =
        String(item?.images?.web?.url || item?.images?.print?.url || "").trim()
      const originalImageUrl =
        String(item?.images?.print?.url || item?.images?.full?.url || item?.images?.web?.url || "").trim()
      const description = [
        item?.description,
        item?.department,
        item?.type,
        Array.isArray(item?.culture) ? item.culture.join(" ") : item?.culture,
        Array.isArray(item?.creators) ? item.creators.map((creator) => creator?.description || creator?.role || "").join(" ") : "",
      ]
        .filter(Boolean)
        .join(" ")

      return buildReferenceImageCandidate({
        title: item?.title || "",
        description,
        imageUrl,
        originalImageUrl,
        sourceUrl: item?.url || "",
        license: String(item?.share_license_status || "").trim(),
        author: Array.isArray(item?.creators) ? item.creators.map((creator) => creator?.description || "").filter(Boolean).join(", ") : "",
        searchQuery,
        source: "cleveland-museum",
        anchorTokens,
        anchorPhrases,
        imageIntent,
      })
    })
  const filtered = filterReferenceImageCandidates(matches, excludedSources, anchorTokens, anchorPhrases, imageIntent)
  const rotation = filtered.length ? safeAttemptIndex % filtered.length : 0
  return filtered.length ? [...filtered.slice(rotation), ...filtered.slice(0, rotation)].slice(0, 8) : []
}

async function collectMetReferenceImageCandidatesByQuery(searchQuery = "", anchorTokens = [], anchorPhrases = [], excludedSources = new Set(), attemptIndex = 0, imageIntent = {}) {
  if (!searchQuery) return []

  const searchUrl = new URL("https://collectionapi.metmuseum.org/public/collection/v1/search")
  searchUrl.search = new URLSearchParams({
    q: searchQuery,
    hasImages: "true",
  }).toString()

  const searchResponse = await fetchWithTimeout(
    searchUrl.toString(),
    { headers: { accept: "application/json" } },
    PUBLIC_IMAGE_QUERY_TIMEOUT_MS
  )
  if (!searchResponse.ok) {
    throw new Error(`Met Museum API zoekopdracht mislukte (${searchResponse.status}).`)
  }

  const searchPayload = await searchResponse.json()
  const objectIds = Array.isArray(searchPayload?.objectIDs) ? searchPayload.objectIDs.slice(0, 12) : []
  if (!objectIds.length) return []

  const detailPayloads = await Promise.all(
    objectIds.map(async (objectId) => {
      try {
        const detailResponse = await fetchWithTimeout(
          `https://collectionapi.metmuseum.org/public/collection/v1/objects/${encodeURIComponent(objectId)}`,
          { headers: { accept: "application/json" } },
          PUBLIC_IMAGE_QUERY_TIMEOUT_MS
        )
        if (!detailResponse.ok) return null
        return await detailResponse.json()
      } catch {
        return null
      }
    })
  )

  const matches = detailPayloads
    .filter(Boolean)
    .map((item) => {
      const imageUrl = String(item?.primaryImageSmall || item?.primaryImage || "").trim()
      const originalImageUrl = String(item?.primaryImage || item?.primaryImageSmall || "").trim()
      const description = [
        item?.artistDisplayName,
        item?.culture,
        item?.period,
        item?.dynasty,
        item?.objectName,
        item?.department,
        Array.isArray(item?.tags) ? item.tags.map((tag) => tag?.term || "").join(" ") : "",
      ]
        .filter(Boolean)
        .join(" ")

      return buildReferenceImageCandidate({
        title: item?.title || "",
        description,
        imageUrl,
        originalImageUrl,
        sourceUrl: item?.objectURL || "",
        license: item?.isPublicDomain ? "CC0" : "",
        author: item?.artistDisplayName || "",
        searchQuery,
        source: "met-museum",
        anchorTokens,
        anchorPhrases,
        imageIntent,
      })
    })
    .filter((item) => item.imageUrl)

  const filtered = filterReferenceImageCandidates(matches, excludedSources, anchorTokens, anchorPhrases, imageIntent)
  const safeAttemptIndex = Math.max(0, Number(attemptIndex) || 0)
  const rotation = filtered.length ? safeAttemptIndex % filtered.length : 0
  return filtered.length ? [...filtered.slice(rotation), ...filtered.slice(0, rotation)].slice(0, 8) : []
}

async function searchReusableReferenceImage({ prompt = "", category = "", kind = "slide", exclude = [], attemptIndex = 0 }) {
  if (kind !== "slide") return null

  const baseAnchorPhrases = buildReusableImageAnchorPhrases({ prompt, category })
  const baseSearchQueries = [
    ...baseAnchorPhrases.map((phrase) => normalizePublicImageSearchQuery(phrase)).filter(Boolean),
    ...buildPublicImageSearchQueries({ prompt, category, attemptIndex }),
  ]
  const aiQueries = await buildAiPublicImageSearchQueries({ prompt, category, kind })
  const combinedSearchQueries = [...new Set([...baseSearchQueries, ...aiQueries].filter(Boolean))]
  const anchorTokens = buildReusableImageQueryAnchorTokens({
    prompt,
    category,
    searchQueries: combinedSearchQueries,
  })
  const anchorPhrases = buildReusableImageQueryAnchorPhrases({
    prompt,
    category,
    searchQueries: combinedSearchQueries,
  })
  const imageIntent = inferReusableImageIntent({
    prompt,
    category,
    anchorTokens,
    anchorPhrases,
  })
  const excludedSources = new Set(
    (Array.isArray(exclude) ? exclude : [])
      .map((value) => normalizeExcludedImageValue(value))
      .filter(Boolean)
  )

  const providerCollectors =
    imageIntent.isPlace || imageIntent.isNature || imageIntent.isFood || imageIntent.isMap
      ? [
          collectOpenverseReferenceImageCandidatesByQuery,
          collectWikimediaReferenceImageCandidatesByQuery,
          collectClevelandReferenceImageCandidatesByQuery,
          collectMetReferenceImageCandidatesByQuery,
        ]
      : imageIntent.isPerson || imageIntent.isHistoric
        ? [
            collectWikimediaReferenceImageCandidatesByQuery,
            collectMetReferenceImageCandidatesByQuery,
            collectClevelandReferenceImageCandidatesByQuery,
            collectOpenverseReferenceImageCandidatesByQuery,
          ]
        : [
            collectOpenverseReferenceImageCandidatesByQuery,
            collectWikimediaReferenceImageCandidatesByQuery,
            collectMetReferenceImageCandidatesByQuery,
            collectClevelandReferenceImageCandidatesByQuery,
          ]

  const aggregatedCandidates = []

  for (const searchQuery of combinedSearchQueries) {
    for (const collector of providerCollectors) {
      try {
        const candidates = await collector(
          searchQuery,
          anchorTokens,
          anchorPhrases,
          excludedSources,
          attemptIndex,
          imageIntent
        )
        if (Array.isArray(candidates) && candidates.length) {
          aggregatedCandidates.push(...candidates)
        }
      } catch (error) {
        console.warn("[images] candidate source failed:", error instanceof Error ? error.message : error)
      }
    }
  }

  const uniqueCandidates = dedupeReferenceImageCandidates(
    aggregatedCandidates.sort((left, right) => right.score - left.score)
  )
  if (!uniqueCandidates.length) return null

  const safeAttemptIndex = Math.max(0, Number(attemptIndex) || 0)
  const rotation = uniqueCandidates.length ? safeAttemptIndex % uniqueCandidates.length : 0
  const rotatedCandidates = uniqueCandidates.length
    ? [...uniqueCandidates.slice(rotation), ...uniqueCandidates.slice(0, rotation)]
    : []

  for (const candidate of rotatedCandidates) {
    const downloaded = await downloadReferenceImageCandidate(candidate)
    if (downloaded) return downloaded
  }

  return null
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

  if (/(oekra[iï]ne|ukraine|aardrijkskunde|kaart|wereldkaart|land|werelddeel|hoofdstad|grens|europa|continent|geografie|oost-europa|zee)/.test(source)) {
    return {
      gradient: ["#0b132b", "#1c2541", "#5bc0be"],
      accent: "#9bf6ff",
      icon: "globe",
      label: "Aardrijkskunde",
    }
  }
  if (/(bank|rekening|pin|pinnen|spaargeld|sparen|rente|pas|geldautomaat|betaal)/.test(source)) {
    return {
      gradient: ["#0f172a", "#123560", "#2dd4bf"],
      accent: "#b6fff2",
      icon: "bank-card",
      label: "Bank en geld",
    }
  }
  if (/(verzeker|polis|premie|eigen risico|risico|dekking|schade)/.test(source)) {
    return {
      gradient: ["#182033", "#23426b", "#f59e0b"],
      accent: "#ffe6a3",
      icon: "shield",
      label: "Zekerheid",
    }
  }
  if (/(werk|baan|beroep|vacature|sollicit|loon|salaris|stage|arbeid)/.test(source)) {
    return {
      gradient: ["#1b1f35", "#334155", "#fb7185"],
      accent: "#ffe0e7",
      icon: "briefcase",
      label: "Werk",
    }
  }
  if (/(productie|markt|vraag|aanbod|fabriek|ondernemen|product|consument)/.test(source)) {
    return {
      gradient: ["#0f172a", "#164e63", "#f97316"],
      accent: "#ffd0a8",
      icon: "factory",
      label: "Markt",
    }
  }
  if (/(^|[^a-z])(euro|euro's|prijs|korting|koop|winkel|betaal|kost)([^a-z]|$)/.test(source)) {
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
    case "bank-card":
      return `
  <rect x="794" y="198" width="270" height="180" rx="28" fill="#ffffff14" stroke="${accent}" stroke-width="8"/>
  <rect x="818" y="246" width="222" height="26" rx="13" fill="${accent}" opacity="0.85"/>
  <rect x="838" y="304" width="66" height="48" rx="10" fill="#ffffffd9"/>
  <circle cx="984" cy="330" r="18" fill="${accent}"/>
  <circle cx="1020" cy="330" r="18" fill="${accent}" opacity="0.58"/>`
    case "shield":
      return `
  <path d="M930 168l124 38v102c0 92-66 164-124 198-58-34-124-106-124-198V206z" fill="#ffffff12" stroke="${accent}" stroke-width="8"/>
  <path d="M930 214v214" stroke="${accent}" stroke-width="10" stroke-linecap="round"/>
  <path d="M858 286h144" stroke="${accent}" stroke-width="10" stroke-linecap="round"/>`
    case "briefcase":
      return `
  <rect x="812" y="230" width="236" height="152" rx="28" fill="#ffffff12" stroke="${accent}" stroke-width="8"/>
  <path d="M878 230v-30c0-18 14-32 32-32h40c18 0 32 14 32 32v30" fill="none" stroke="${accent}" stroke-width="8"/>
  <rect x="910" y="290" width="40" height="24" rx="10" fill="${accent}"/>
  <path d="M812 296h236" stroke="${accent}" stroke-width="8"/>`
    case "factory":
      return `
  <path d="M804 382V250l88 44v-44l96 48v84z" fill="#ffffff14" stroke="${accent}" stroke-width="8" stroke-linejoin="round"/>
  <rect x="992" y="192" width="44" height="190" rx="12" fill="#ffffff10" stroke="${accent}" stroke-width="8"/>
  <rect x="844" y="330" width="34" height="34" rx="8" fill="${accent}"/>
  <rect x="900" y="330" width="34" height="34" rx="8" fill="${accent}" opacity="0.76"/>
  <rect x="956" y="330" width="34" height="34" rx="8" fill="${accent}" opacity="0.58"/>`
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

function sanitizeVisualPrompt(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function buildVisualPrompt({ prompt, category = "", kind = "question" }) {
  const cleanPrompt = sanitizeVisualPrompt(prompt)
  const cleanCategory = sanitizeVisualPrompt(category)
  const domain = detectTopicDomain(`${cleanCategory} ${cleanPrompt}`)
  const compositionHint =
    kind === "slide"
      ? "Create a polished 16:9 classroom slide illustration with cinematic lighting, one clear subject, natural depth, and a modern semi-realistic style."
      : "Create a polished educational illustration with cinematic lighting, one clear focal point, natural depth, and a modern semi-realistic style."
  const domainHints = {
    tijd: "Use clocks, timelines, or clear time-based objects that match the concept.",
    meten: "Use rulers, measuring tapes, scales, containers, or concrete measurement visuals.",
    rekenen: "Use pies, blocks, fractions, or number-based objects without written text.",
    taal: "Use books, speech bubbles without text, reading scenes, or grammar-related symbols.",
    aardrijkskunde: "Use maps, globes, landscapes, flags without text, or place-related visuals.",
    geschiedenis: "Use historical objects, buildings, tools, or era-appropriate scenes.",
    biologie: "Use body parts, plants, cells, organs, or nature details that match the topic.",
    economie: "Use banks, payment cards, euro coins, contracts, insurance papers, jobs, factories, shops, or market scenes as appropriate.",
    cultuur: isIslamicTopic(cleanPrompt, cleanCategory)
      ? "Avoid faces, prophets, people, or living beings; use abstract patterns, books, architecture, crescents, light, prayer rugs, or symbolic objects."
      : "Use cultural symbols, buildings, objects, or respectful classroom-friendly scenes.",
    general: "Use one concrete school-friendly visual that clearly matches the topic.",
  }

  return [
    compositionHint,
    cleanCategory ? `Topic area: ${cleanCategory}.` : "",
    cleanPrompt ? `Main subject: ${cleanPrompt}.` : "",
    domainHints[domain] || domainHints.general,
    "Show a real scene or object instead of a flat icon, badge, infographic, UI card, or logo.",
    "No words, no labels, no interface elements, no watermarks.",
  ]
    .filter(Boolean)
    .join(" ")
}

function ensureQuestionImagePrompt(questionPrompt, category, existingPrompt = "") {
  return sanitizeVisualPrompt(existingPrompt) || buildVisualPrompt({ prompt: questionPrompt, category, kind: "question" })
}

function ensureSlideImagePrompt({ lessonTitle = "", slideTitle = "", focus = "", existingPrompt = "" }) {
  return (
    sanitizeVisualPrompt(existingPrompt) ||
    buildVisualPrompt({
      prompt: [lessonTitle, slideTitle, focus].filter(Boolean).join(". "),
      category: lessonTitle,
      kind: "slide",
    })
  )
}

function imageCacheFilePath({ prompt, category, kind }) {
  const providerSignature = [openAI ? `openai:${openAIImageModel}` : "", geminiImageClient ? `gemini:${geminiImageModel}` : ""]
    .filter(Boolean)
    .join("|") || "fallback"
  const cacheKey = crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        prompt: sanitizeVisualPrompt(prompt),
        category: sanitizeVisualPrompt(category),
        kind,
        providers: providerSignature,
      })
    )
    .digest("hex")

  return path.join(generatedImagesPath, `${cacheKey}.png`)
}

function readCachedImageBuffer(cachePath) {
  try {
    if (fs.existsSync(cachePath)) {
      return fs.readFileSync(cachePath)
    }
  } catch (error) {
    console.warn("[images] cache read failed:", error instanceof Error ? error.message : error)
  }

  return null
}

function writeCachedImageBuffer(cachePath, imageBuffer) {
  try {
    ensureGeneratedImagesDir()
    fs.writeFileSync(cachePath, imageBuffer)
  } catch (error) {
    console.warn("[images] cache write failed:", error instanceof Error ? error.message : error)
  }
}

async function generateOpenAIImageBuffer({ prompt, category, kind = "question" }) {
  if (!openAI) return null

  const size = kind === "slide" ? "1536x1024" : "1024x1024"
  const imagePrompt = buildVisualPrompt({ prompt, category, kind })
  const isGPTImageModel = /^gpt-image|^chatgpt-image/i.test(openAIImageModel)
  const nonGptOptions = {
    model: openAIImageModel,
    prompt: imagePrompt,
    size: kind === "slide" ? "1792x1024" : "1024x1024",
    response_format: "b64_json",
  }

  if (openAIImageModel === "dall-e-3") {
    nonGptOptions.quality = "standard"
    nonGptOptions.style = "natural"
  }

  const response = await withTimeout(
    openAI.images.generate(
      isGPTImageModel
        ? {
            model: openAIImageModel,
            prompt: imagePrompt,
            size,
            quality: "low",
            output_format: "png",
            background: "opaque",
          }
        : nonGptOptions
    ),
    AI_IMAGE_TIMEOUT_MS
  )

  const firstImage = response?.data?.[0]
  if (firstImage?.b64_json) {
    return Buffer.from(firstImage.b64_json, "base64")
  }

  if (firstImage?.url) {
    const imageResponse = await fetchWithTimeout(firstImage.url, {}, AI_IMAGE_TIMEOUT_MS)
    if (!imageResponse.ok) {
      throw new Error(`Kon AI-afbeelding niet ophalen (${imageResponse.status}).`)
    }
    return Buffer.from(await imageResponse.arrayBuffer())
  }

  return null
}

async function generateGeminiImageBuffer({ prompt, category, kind = "question" }) {
  if (!geminiImageClient) return null

  const imagePrompt = buildVisualPrompt({ prompt, category, kind })
  const baseRequest = {
    model: geminiImageModel,
    prompt: imagePrompt,
    response_format: "b64_json",
  }

  let response

  try {
    response = await withTimeout(
      geminiImageClient.images.generate({
        ...baseRequest,
        size: kind === "slide" ? "1536x1024" : "1024x1024",
      }),
      AI_IMAGE_TIMEOUT_MS
    )
  } catch (error) {
    response = await withTimeout(geminiImageClient.images.generate(baseRequest), AI_IMAGE_TIMEOUT_MS)
    console.warn("[images] Gemini size-specific request failed, retried default size:", error instanceof Error ? error.message : error)
  }

  const firstImage = response?.data?.[0]
  if (firstImage?.b64_json) {
    return Buffer.from(firstImage.b64_json, "base64")
  }

  if (firstImage?.url) {
    const imageResponse = await fetchWithTimeout(firstImage.url, {}, AI_IMAGE_TIMEOUT_MS)
    if (!imageResponse.ok) {
      throw new Error(`Kon Gemini-afbeelding niet ophalen (${imageResponse.status}).`)
    }
    return Buffer.from(await imageResponse.arrayBuffer())
  }

  return null
}

async function generateAIImageResult({ prompt, category, kind = "question" }) {
  if (openAI) {
    try {
      const buffer = await generateOpenAIImageBuffer({ prompt, category, kind })
      if (buffer) return { buffer, source: "openai" }
    } catch (error) {
      console.warn("[images] OpenAI image generation failed:", error instanceof Error ? error.message : error)
    }
  }

  if (geminiImageClient) {
    try {
      const buffer = await generateGeminiImageBuffer({ prompt, category, kind })
      if (buffer) return { buffer, source: "gemini" }
    } catch (error) {
      console.warn("[images] Gemini image generation failed:", error instanceof Error ? error.message : error)
    }
  }

  return null
}

function createTeams(teamNames = DEFAULT_TEAMS) {
  const cleanedNames = teamNames.map((name) => String(name).trim()).filter(Boolean)
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
    ownerUsername: "",
    ownerDisplayName: "",
    hostOnline: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    players: [],
    teams: createTeams(),
    questions: [],
    currentQuestionIndex: -1,
    answeredPlayers: new Set(),
    playerAnswers: new Map(),
    lessonResponses: new Map(),
    lesson: createEmptyLessonState(),
    math: createEmptyMathState(),
    closingTimeout: null,
    game: createIdleGameState(),
  }
  rooms.set(roomCode, room)
  socketToRoom.set(hostSocketId, roomCode)
  return room
}

function getRoomBySocketId(socketId) {
  const roomCode = socketToRoom.get(socketId)
  return roomCode ? rooms.get(roomCode) ?? null : null
}

function getPlayerBySocketId(room, socketId) {
  return room?.players.find((player) => player.socketId === socketId) ?? null
}

function detachPlayerSocketFromOtherRoom(socketId, nextRoomCode = "") {
  const previousRoomCode = socketToRoom.get(socketId)
  if (!previousRoomCode || previousRoomCode === nextRoomCode) return

  const previousRoom = rooms.get(previousRoomCode)
  if (!previousRoom) return

  const previousPlayer = getPlayerBySocketId(previousRoom, socketId)
  if (!previousPlayer) return

  previousPlayer.socketId = null
  previousPlayer.connected = false
  emitStateToRoom(previousRoom)
}

function findMathRoomForHomeResume(name, learnerCode) {
  const normalizedName = normalizeParticipantName(name)
  const normalizedLearnerCode = normalizeLearnerCode(learnerCode)
  if (!normalizedName || !normalizedLearnerCode) return { room: null, player: null, ambiguous: false }

  const matches = []
  for (const room of rooms.values()) {
    if (room?.game?.mode !== "math") continue
    const player = room.players.find(
      (entry) =>
        normalizeParticipantName(entry.name) === normalizedName &&
        normalizeLearnerCode(entry.learnerCode) === normalizedLearnerCode
    )
    if (player) matches.push({ room, player })
  }

  if (matches.length !== 1) {
    return {
      room: null,
      player: null,
      ambiguous: matches.length > 1,
    }
  }

  return {
    room: matches[0].room,
    player: matches[0].player,
    ambiguous: false,
  }
}

function getOnlinePlayers(room) {
  return room?.players.filter((player) => player.connected !== false && player.socketId) ?? []
}

function markRoomUpdated(room) {
  if (!room) return
  room.updatedAt = new Date().toISOString()
}

function getHostSession(socketId) {
  return hostSessions.get(socketId) ?? null
}

function createHostSession(account, roomCode = "") {
  const now = Date.now()
  return {
    token: crypto.randomBytes(32).toString("hex"),
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    canManageAccounts: Boolean(account.canManageAccounts),
    roomCode: String(roomCode || "").trim().toUpperCase(),
    createdAt: now,
    expiresAt: now + HOST_SESSION_TTL_MS,
  }
}

function rememberHostRoomForSession(session, roomCode = "") {
  if (!session) return
  session.roomCode = String(roomCode || "").trim().toUpperCase()
  session.expiresAt = Date.now() + HOST_SESSION_TTL_MS
  if (session.token) {
    hostSessionTokens.set(session.token, session)
  }
}

function buildHostSessionPayload(session) {
  if (!session) return null
  return {
    username: session.username,
    displayName: session.displayName,
    role: session.role,
    canManageAccounts: Boolean(session.canManageAccounts),
    roomCode: session.roomCode || "",
    sessionToken: session.token || "",
  }
}

function pruneExpiredHostSessionTokens() {
  const now = Date.now()
  for (const [token, session] of hostSessionTokens.entries()) {
    if (!session?.expiresAt || session.expiresAt > now) continue
    hostSessionTokens.delete(token)
    for (const [socketId, activeSession] of hostSessions.entries()) {
      if (activeSession?.token === token) {
        hostSessions.delete(socketId)
      }
    }
  }
}

function getHostSessionByToken(token) {
  pruneExpiredHostSessionTokens()
  const normalizedToken = String(token || "").trim()
  if (!normalizedToken) return null
  const session = hostSessionTokens.get(normalizedToken) ?? null
  if (!session) return null
  session.expiresAt = Date.now() + HOST_SESSION_TTL_MS
  hostSessionTokens.set(normalizedToken, session)
  return session
}

function invalidateHostSessionTokensForUsername(username) {
  const normalizedUsername = normalizeTeacherUsername(username)
  if (!normalizedUsername) return

  for (const [token, session] of hostSessionTokens.entries()) {
    if (session?.username === normalizedUsername) {
      hostSessionTokens.delete(token)
    }
  }

  for (const [socketId, session] of hostSessions.entries()) {
    if (session?.username !== normalizedUsername) continue
    hostSessions.set(socketId, {
      ...session,
      token: "",
      expiresAt: Date.now(),
    })
  }
}

function detachHostSessionTokenFromOtherSockets(token, currentSocketId) {
  const normalizedToken = String(token || "").trim()
  if (!normalizedToken) return

  for (const [socketId, session] of hostSessions.entries()) {
    if (socketId === currentSocketId || session?.token !== normalizedToken) continue
    hostSocketIds.delete(socketId)
    hostSessions.delete(socketId)
  }
}

function clearHostSession(socketId, { invalidateToken = false } = {}) {
  const session = hostSessions.get(socketId) ?? null
  hostSessions.delete(socketId)
  if (invalidateToken && session?.token) {
    hostSessionTokens.delete(session.token)
  }
}

function isHostOwner(socketId) {
  return getHostSession(socketId)?.role === "owner"
}

function canManageTeacherAccounts(socketId) {
  return Boolean(getHostSession(socketId)?.canManageAccounts)
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

function currentLessonPhase(room) {
  const index = room.lesson?.currentPhaseIndex ?? -1
  return index >= 0 ? room.lesson?.phases?.[index] ?? null : null
}

function getActiveLessonPrompt(lesson) {
  if (!lesson) return ""
  const phase = lesson.currentPhaseIndex >= 0 ? lesson.phases?.[lesson.currentPhaseIndex] ?? null : null
  return lesson.activePrompt || phase?.interactivePrompt || ""
}

function getActiveLessonExpectedAnswer(lesson) {
  if (!lesson) return ""
  const phase = lesson.currentPhaseIndex >= 0 ? lesson.phases?.[lesson.currentPhaseIndex] ?? null : null
  return lesson.activeExpectedAnswer || phase?.expectedAnswer || ""
}

function currentPresentationSlide(lesson) {
  if (!lesson?.presentation?.slides?.length) return null
  const slideIndex = Math.max(0, Math.min(lesson.currentPhaseIndex >= 0 ? lesson.currentPhaseIndex : 0, lesson.presentation.slides.length - 1))
  return lesson.presentation.slides[slideIndex] ?? lesson.presentation.slides[0] ?? null
}

function currentPresentationScene(lesson) {
  if (!lesson?.presentation?.video?.scenes?.length) return null
  const sceneIndex = Math.max(0, Math.min(lesson.currentPhaseIndex >= 0 ? lesson.currentPhaseIndex : 0, lesson.presentation.video.scenes.length - 1))
  return lesson.presentation.video.scenes[sceneIndex] ?? lesson.presentation.video.scenes[0] ?? null
}

function sanitizePresentationSlide(slide, viewer = "host") {
  if (!slide) return null
  const imagePrompt = slide.imagePrompt || `${slide.title || ""} ${slide.focus || slide.studentViewText || ""}`.trim()
  const safeSlide = {
    id: slide.id,
    title: slide.title,
    content: slide.content || slide.studentViewText || slide.focus || "",
    studentViewText: slide.studentViewText || slide.content || slide.focus || "",
    focus: slide.focus || slide.studentViewText || slide.content || "",
    bullets: [...(slide.bullets || [])],
    imagePrompt,
    imageAlt: slide.imageAlt || slide.title || "Presentatiedia",
    manualImageUrl: sanitizeManualImageUrl(slide.manualImageUrl || ""),
    imageUrl: buildSignedImageUrl({
      prompt: imagePrompt,
      category: slide.title || "Presentatie",
      kind: "slide",
    }),
  }

  if (viewer === "player") return safeSlide
  return {
    ...safeSlide,
    speakerNotes: slide.speakerNotes || "",
    manualImageSourceUrl: String(slide.manualImageSourceUrl || "").trim(),
    manualImageSourceImageUrl: String(slide.manualImageSourceImageUrl || "").trim(),
    manualImageSearchQuery: String(slide.manualImageSearchQuery || "").trim(),
    manualImageSourceTitle: String(slide.manualImageSourceTitle || "").trim(),
    manualImageSearchAttempt: Math.max(0, Number(slide.manualImageSearchAttempt) || 0),
    manualImageSourceHistory: sanitizeImageSourceHistory(slide.manualImageSourceHistory || []),
  }
}

function sanitizePresentationScene(scene, viewer = "host") {
  if (!scene) return null
  const safeScene = {
    id: scene.id,
    title: scene.title,
    narration: scene.studentNarration || scene.narration || "",
    studentNarration: scene.studentNarration || scene.narration || "",
    visualHint: scene.visualHint || "",
  }

  if (viewer === "player") return safeScene
  return {
    ...safeScene,
    teacherCue: scene.teacherCue || "",
  }
}

function normalizeStudentFacingText(text, fallback = "Beantwoord de volgende vraag.") {
  const source = String(text || "").trim()
  if (!source) return fallback

  const replacements = [
    [/^leerlingen kijken naar\s+/i, "Kijk naar "],
    [/^leerlingen kijken\s+/i, "Kijk "],
    [/^leerlingen luisteren naar\s+/i, "Luister naar "],
    [/^leerlingen luisteren\s+/i, "Luister "],
    [/^leerlingen bespreken\s+/i, "Bespreek "],
    [/^leerlingen werken aan\s+/i, "Werk aan "],
    [/^leerlingen werken\s+/i, "Werk "],
    [/^leerlingen beantwoorden\s+/i, "Beantwoord "],
    [/^leerlingen schrijven op\s+/i, "Schrijf op "],
    [/^leerlingen schrijven\s+/i, "Schrijf "],
    [/^leerlingen geven aan\s+/i, "Geef aan "],
    [/^leerlingen wijzen aan\s+/i, "Wijs aan "],
    [/^leerlingen vullen in\s+/i, "Vul in "],
    [/^de leerlingen moeten nu\s+/i, "Je gaat nu "],
    [/^de leerlingen moeten\s+/i, "Je gaat nu "],
    [/^de leerlingen gaan nu\s+/i, "Je gaat nu "],
    [/^de leerlingen gaan\s+/i, "Je gaat nu "],
    [/^laat leerlingen nadenken over\s+/i, "Denk na over "],
    [/^laat de leerlingen nadenken over\s+/i, "Denk na over "],
    [/^laat leerlingen\s+/i, ""],
    [/^laat de leerlingen\s+/i, ""],
    [/^de docent vraagt de klas om\s+/i, "Beantwoord deze opdracht: "],
    [/^de docent vraagt de klas\s+/i, "Beantwoord deze vraag: "],
    [/^vraag de klas om\s+/i, "Beantwoord deze opdracht: "],
    [/^vraag de klas\s+/i, "Beantwoord deze vraag: "],
    [/^de leerlingen\b/i, "Jullie"],
    [/^leerlingen\b/i, "Jullie"],
  ]

  let normalized = source
  for (const [pattern, replacement] of replacements) {
    normalized = normalized.replace(pattern, replacement)
  }

  if (/^jullie\b/i.test(normalized)) {
    normalized = normalized
      .replace(/\bhun eigen\b/gi, "jullie eigen")
      .replace(/\bhun\b/gi, "jullie")
      .replace(/\bhen\b/gi, "jullie")
      .replace(/\bze luisteren\b/gi, "Jullie luisteren")
      .replace(/\bze kijken\b/gi, "Jullie kijken")
      .replace(/\bze bespreken\b/gi, "Jullie bespreken")
      .replace(/\bze denken\b/gi, "Jullie denken")
      .replace(/\bze delen\b/gi, "Jullie delen")
      .replace(/\bze geven\b/gi, "Jullie geven")
      .replace(/\bze noemen\b/gi, "Jullie noemen")
  }

  normalized = normalized.replace(/\s+/g, " ").trim()
  return normalized || fallback
}

function buildStudentPhasePrompt(lesson, currentPhase, activePrompt) {
  const candidate = activePrompt || currentPhase?.interactivePrompt || currentPhase?.goal || currentPhase?.studentActivity || ""
  return normalizeStudentFacingText(candidate, "Volg de uitleg en beantwoord de volgende opdracht.")
}

function withLessonPhaseContext(lesson, phaseIndex = lesson?.currentPhaseIndex ?? -1) {
  const phase = phaseIndex >= 0 ? lesson?.phases?.[phaseIndex] ?? null : null
  return {
    ...createEmptyLessonState(),
    ...lesson,
    currentPhaseIndex: phase ? phaseIndex : -1,
    activePrompt: phase?.interactivePrompt || "",
    activeExpectedAnswer: phase?.expectedAnswer || "",
    activeKeywords: [...(phase?.keywords || [])],
    promptVersion: Date.now(),
  }
}

function sanitizeQuestion(question, viewer = "host", room = null) {
  if (!question) return null
  const prompt = String(question.prompt || question.question_text || "").trim()
  const imagePrompt = ensureQuestionImagePrompt(prompt, question.category, question.imagePrompt)
  const questionType = normalizePracticeQuestionFormat(question.questionType)
  const displayAnswer =
    String(question.displayAnswer || question.options?.[question.correctIndex] || question.acceptedAnswers?.[0] || "").trim()
  const baseQuestion = {
    id: question.id,
    prompt,
    question_text: prompt,
    options: [...(question.options || [])],
    questionType,
    answerPlaceholder: String(question.answerPlaceholder || "Typ hier je antwoord").trim() || "Typ hier je antwoord",
    category: question.category,
    imagePrompt,
    imageAlt: question.imageAlt || prompt,
    manualImageUrl: sanitizeManualImageUrl(question.manualImageUrl || ""),
    durationSec: Number(question.durationSec) || room?.game?.questionDurationSec || 20,
    imageUrl: buildSignedImageUrl({
      prompt: imagePrompt,
      category: question.category,
      kind: "question",
    }),
  }

  if (viewer === "player") {
    const isBattle = room?.game?.mode === "battle" && room?.game?.source !== "practice"
    const isPractice = room?.game?.source === "practice"
    if (isBattle && room?.game?.status === "preview") return null
    if (isBattle && room?.game?.status !== "revealed") return baseQuestion
    if (isPractice) return baseQuestion
    return {
      ...baseQuestion,
      explanation: question.explanation,
      correctIndex: question.correctIndex,
      displayAnswer,
    }
  }

  return {
    ...baseQuestion,
    explanation: question.explanation,
    correctIndex: question.correctIndex,
    displayAnswer,
    acceptedAnswers: [...(question.acceptedAnswers || [])],
    manualImageSourceUrl: String(question.manualImageSourceUrl || "").trim(),
    manualImageSourceImageUrl: String(question.manualImageSourceImageUrl || "").trim(),
    manualImageSearchQuery: String(question.manualImageSearchQuery || "").trim(),
    manualImageSourceTitle: String(question.manualImageSourceTitle || "").trim(),
    manualImageSearchAttempt: Math.max(0, Number(question.manualImageSearchAttempt) || 0),
    manualImageSourceHistory: sanitizeImageSourceHistory(question.manualImageSourceHistory || []),
  }
}

function sanitizeLesson(lesson, viewer = "host") {
  if (!lesson || !Array.isArray(lesson.phases) || lesson.phases.length === 0) return null
  const currentPhase =
    lesson.currentPhaseIndex >= 0 ? lesson.phases[lesson.currentPhaseIndex] ?? null : null
  const activePrompt = getActiveLessonPrompt(lesson)
  const activeExpectedAnswer = getActiveLessonExpectedAnswer(lesson)

  if (viewer === "player") {
    const safeSlide = sanitizePresentationSlide(currentPresentationSlide(lesson), "player")
    const safeScene = sanitizePresentationScene(currentPresentationScene(lesson), "player")
    const rawPlayerPrompt = normalizeStudentFacingText(activePrompt || currentPhase?.interactivePrompt || "", "")
    const playerPrompt = rawPlayerPrompt || buildStudentPhasePrompt(lesson, currentPhase, activePrompt)
    const playerActivity = normalizeStudentFacingText(currentPhase?.studentActivity || currentPhase?.goal || playerPrompt, playerPrompt)
    return {
      title: lesson.title,
      model: lesson.model,
      promptVersion: lesson.promptVersion || 0,
      currentPhaseIndex: lesson.currentPhaseIndex,
      totalPhases: lesson.phases.length,
      currentPhase: currentPhase
        ? {
            id: currentPhase.id,
            title: currentPhase.title,
            minutes: currentPhase.minutes,
            prompt: playerPrompt,
            studentActivity: playerActivity,
            hasPrompt: Boolean(rawPlayerPrompt),
            promptVersion: lesson.promptVersion || 0,
          }
        : null,
      presentation: lesson.presentation
        ? {
            title: lesson.presentation.title,
            style: lesson.presentation.style,
            slideCount: lesson.presentation.slides.length,
            currentSlide: safeSlide,
            video: lesson.presentation.video
              ? {
                  title: lesson.presentation.video.title,
                  summary: lesson.presentation.video.studentViewText || lesson.presentation.video.summary,
                  currentScene: safeScene,
                }
              : null,
          }
        : null,
    }
  }

  return {
    libraryId: lesson.libraryId || null,
    title: lesson.title,
    model: lesson.model,
    audience: lesson.audience,
    durationMinutes: lesson.durationMinutes,
    lessonGoal: lesson.lessonGoal,
    successCriteria: lesson.successCriteria,
    materials: lesson.materials,
    includePracticeTest: Boolean(lesson.practiceTest?.questions?.length),
    includePresentation: Boolean(lesson.presentation?.slides?.length),
    includeVideoPlan: Boolean(lesson.presentation?.video?.scenes?.length),
    practiceTest: lesson.practiceTest
      ? {
          title: lesson.practiceTest.title,
          instructions: lesson.practiceTest.instructions,
          questionCount: lesson.practiceTest.questions.length,
        }
      : null,
    presentation: lesson.presentation
      ? {
          title: lesson.presentation.title,
          style: lesson.presentation.style,
          slideCount: lesson.presentation.slides.length,
          currentSlide: sanitizePresentationSlide(currentPresentationSlide(lesson), "host"),
          video: lesson.presentation.video
            ? {
                title: lesson.presentation.video.title,
                summary: lesson.presentation.video.summary,
                sceneCount: lesson.presentation.video.scenes.length,
                currentScene: sanitizePresentationScene(currentPresentationScene(lesson), "host"),
              }
            : null,
        }
      : null,
    promptVersion: lesson.promptVersion || 0,
    currentPhaseIndex: lesson.currentPhaseIndex,
    totalPhases: lesson.phases.length,
    currentPhase: currentPhase
      ? {
          ...currentPhase,
          prompt: activePrompt,
          expectedAnswer: activeExpectedAnswer,
        }
      : null,
    phases: lesson.phases.map((phase) => ({
      id: phase.id,
      title: phase.title,
      goal: phase.goal,
      minutes: phase.minutes,
      expectedAnswer: phase.expectedAnswer,
      keywords: phase.keywords,
    })),
  }
}

function syncTeamScores(room) {
  if (!room?.game?.groupModeEnabled) {
    room.teams = room.teams.map((team) => ({
      ...team,
      score: 0,
    }))
    return
  }

  room.teams = room.teams.map((team) => ({
    ...team,
    score: room.players.filter((player) => player.teamId === team.id).reduce((sum, player) => sum + player.score, 0),
  }))
}

function sortedTeamsByScore(room) {
  syncTeamScores(room)
  return [...room.teams].sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
}

function getTeamRaceSnapshot(room) {
  if (!room?.game?.groupModeEnabled) {
    return {
      sortedTeams: [],
      leader: null,
      runnerUp: null,
      gap: 0,
    }
  }

  const sortedTeams = sortedTeamsByScore(room)
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

function getQuestionScoringProfile(room, questionIndex = room.currentQuestionIndex) {
  const isBattleRound = room?.game?.mode === "battle" && room?.game?.source !== "practice"
  const remainingIncludingCurrent =
    Number.isInteger(questionIndex) && questionIndex >= 0
      ? Math.max(0, room.questions.length - questionIndex)
      : 0
  const race = getTeamRaceSnapshot(room)
  const closeScoreRace = Boolean(race.leader && race.runnerUp && race.gap <= FINAL_SPRINT_CLOSE_GAP)
  const finalSprintActive = Boolean(
    isBattleRound && remainingIncludingCurrent > 0 && remainingIncludingCurrent <= FINAL_SPRINT_QUESTIONS && closeScoreRace
  )

  return {
    multiplier: finalSprintActive ? 2 : 1,
    finalSprintActive,
    remainingIncludingCurrent,
    leader: race.leader,
    runnerUp: race.runnerUp,
    gap: race.gap,
  }
}

function applyQuestionScoringProfile(room, questionIndex = room.currentQuestionIndex) {
  const profile = getQuestionScoringProfile(room, questionIndex)

  room.game = {
    ...room.game,
    questionMultiplier: profile.multiplier,
    finalSprintActive: profile.finalSprintActive,
    leadingTeamId: profile.leader?.id ?? null,
    leadingTeamName: profile.leader?.name ?? "",
    leadingTeamScore: profile.leader?.score ?? 0,
    runnerUpTeamId: profile.runnerUp?.id ?? null,
    runnerUpTeamName: profile.runnerUp?.name ?? "",
    runnerUpTeamScore: profile.runnerUp?.score ?? 0,
    leadingGap: profile.gap,
  }

  return profile
}

function getBattleAnswerScoring(room, elapsedMs, durationSec) {
  const safeDurationMs = Math.max(1000, (Number(durationSec) || 20) * 1000)
  const multiplier = Math.max(1, Number(room?.game?.questionMultiplier) || 1)
  const remainingRatio = Math.max(0, Math.min(1, (safeDurationMs - elapsedMs) / safeDurationMs))
  const basePoints = BASE_CORRECT_POINTS * multiplier
  const speedBonus = Math.max(0, Math.round(MAX_SPEED_BONUS * multiplier * remainingRatio))

  return {
    multiplier,
    basePoints,
    speedBonus,
    awardedPoints: basePoints + speedBonus,
  }
}

function buildPlayerAnswerResultPayload(room, player, answerRecord, question) {
  const questionType = normalizePracticeQuestionFormat(question?.questionType)
  const correctAnswer =
    String(question?.displayAnswer || question?.options?.[question?.correctIndex] || question?.acceptedAnswers?.[0] || "").trim()
  return {
    answerIndex: answerRecord?.answerIndex ?? null,
    answerText: String(answerRecord?.answerText ?? "").trim(),
    questionType,
    correct: Boolean(answerRecord?.isCorrect),
    correctIndex: question?.correctIndex,
    correctAnswer,
    explanation: question?.explanation || "",
    awardedPoints: Number(answerRecord?.awardedPoints) || 0,
    basePoints: Number(answerRecord?.basePoints) || 0,
    speedBonus: Number(answerRecord?.speedBonus) || 0,
    multiplier: Math.max(1, Number(answerRecord?.multiplier) || Number(room?.game?.questionMultiplier) || 1),
    playerScore: player?.score ?? 0,
    teamScore: room.teams.find((team) => team.id === player?.teamId)?.score ?? 0,
  }
}

function getBattleQuestionDurationSec(room, question = currentQuestion(room)) {
  return Math.max(5, Number(question?.durationSec) || Number(room?.game?.questionDurationSec) || 20)
}

function hasBattleAnswerWindowExpired(room, question = currentQuestion(room)) {
  if (!room || room.game?.mode !== "battle" || !question) return false
  const startTime = room.game.questionStartedAt ? new Date(room.game.questionStartedAt).getTime() : 0
  if (!startTime) return false
  return Date.now() >= startTime + getBattleQuestionDurationSec(room, question) * 1000
}

function canRevealBattleAnswer(room, question = currentQuestion(room)) {
  if (!room || room.game?.mode !== "battle" || room.game?.source === "practice" || room.game?.status !== "live" || !question) {
    return false
  }

  const totalPlayers = getOnlinePlayers(room).length
  const allAnswered = totalPlayers > 0 && room.answeredPlayers.size >= totalPlayers
  return allAnswered || hasBattleAnswerWindowExpired(room, question)
}

function emitBattleRevealResults(room, question) {
  if (!question) return

  for (const player of room.players) {
    if (!player?.socketId) continue
    const answerRecord = room.playerAnswers.get(player.id)
    if (!answerRecord) continue

    io.to(player.socketId).emit("player:answer:result", buildPlayerAnswerResultPayload(room, player, answerRecord, question))
  }
}

function leaderboard(room) {
  return [...room.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

function sanitizePlayerForClient(player) {
  return {
    id: player.id,
    name: player.name,
    learnerCode: player.learnerCode || "",
    teamId: player.teamId,
    classId: player.classId || "",
    className: player.className || "",
    score: player.score,
    connected: player.connected !== false,
  }
}

function reassignPlayersToExistingTeams(room) {
  const fallbackTeamId = room.teams[0]?.id ?? "team-1"
  room.players = room.players.map((player) => ({
    ...player,
    teamId:
      room.game.mode !== "math" && !String(player.teamId ?? "").trim()
        ? ""
        : room.teams.some((team) => team.id === player.teamId)
          ? player.teamId
          : fallbackTeamId,
  }))
}

function applyGroupModeSettings(room, groupModeEnabled, teamNames = null) {
  const nextGroupModeEnabled = Boolean(groupModeEnabled)

  if (Array.isArray(teamNames) && teamNames.length > 0) {
    room.teams = createTeams(teamNames)
  } else if (!room.teams.length) {
    room.teams = createTeams()
  }

  room.game = {
    ...room.game,
    groupModeEnabled: nextGroupModeEnabled,
  }

  if (nextGroupModeEnabled) {
    reassignPlayersToExistingTeams(room)
  } else {
    room.players = room.players.map((player) => ({
      ...player,
      teamId: "",
    }))
  }

  syncTeamScores(room)
  return nextGroupModeEnabled
}

function buildStatePayload(room, viewer = "host", playerId = "") {
  syncTeamScores(room)
  const race = getTeamRaceSnapshot(room)
  const lessonPhase = currentLessonPhase(room)
  const onlinePlayers = getOnlinePlayers(room)
  const mathState = sanitizeMathState(room, viewer, playerId)
  const hidePeerDataForPlayer = viewer === "player" && room.game.mode === "math"
  const answeredCount =
    room.game.mode === "math"
      ? room.players.filter((player) => {
          const progress = room.math?.playerProgress?.get(player.id)
          return Boolean(progress?.lastAnsweredAt)
        }).length
      : room.game.mode === "lesson" && lessonPhase
        ? room.lessonResponses.size
        : room.answeredPlayers.size
  const totalPlayers = onlinePlayers.length
  const activeQuestion = currentQuestion(room)
  const questionDurationSec =
    Number(activeQuestion?.durationSec) || Number(room.game.questionDurationSec) || 20
  return {
    players: hidePeerDataForPlayer ? [] : room.players.map(sanitizePlayerForClient),
    teams: hidePeerDataForPlayer ? [] : room.teams,
    leaderboard: hidePeerDataForPlayer ? [] : leaderboard(room).map(sanitizePlayerForClient),
    game: {
      ...room.game,
      questionDurationSec,
      currentQuestionIndex: room.currentQuestionIndex,
      totalQuestions: room.questions.length,
      currentPhaseIndex: room.lesson?.currentPhaseIndex ?? -1,
      totalPhases: room.lesson?.phases?.length ?? 0,
      roomCodeActive: true,
      questionMultiplier: Math.max(1, Number(room.game.questionMultiplier) || 1),
      finalSprintActive: Boolean(room.game.finalSprintActive),
      groupModeEnabled: Boolean(room.game.groupModeEnabled),
      leadingTeamId: room.game.leadingTeamId ?? race.leader?.id ?? null,
      leadingTeamName: room.game.leadingTeamName || race.leader?.name || "",
      leadingTeamScore: Number(room.game.leadingTeamScore) || race.leader?.score || 0,
      runnerUpTeamId: room.game.runnerUpTeamId ?? race.runnerUp?.id ?? null,
      runnerUpTeamName: room.game.runnerUpTeamName || race.runnerUp?.name || "",
      runnerUpTeamScore: Number(room.game.runnerUpTeamScore) || race.runnerUp?.score || 0,
      leadingGap: Number(room.game.leadingGap) || race.gap || 0,
      answeredCount,
      totalPlayers,
      allAnswered: totalPlayers > 0 && answeredCount >= totalPlayers,
      question: sanitizeQuestion(activeQuestion, viewer, room),
      lesson: sanitizeLesson(room.lesson, viewer),
      math: mathState,
    },
  }
}

function normalizeLessonLibraryEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object") return null
  const entryId = String(rawEntry.id ?? generateEntityId("lesson"))

  const normalizedLesson = normalizeLessonPackage(rawEntry.lesson, {
    topic: String(rawEntry.topic ?? "").trim() || "algemeen thema",
    audience: String(rawEntry.audience ?? "vmbo").trim() || "vmbo",
    lessonModel: String(rawEntry.model ?? "edi").trim() || "edi",
    durationMinutes: Number(rawEntry.durationMinutes) || 45,
    includePracticeTest: Boolean(rawEntry.lesson?.practiceTest || rawEntry.practiceQuestionCount),
    includePresentation: Boolean(rawEntry.lesson?.presentation || rawEntry.slideCount),
    includeVideoPlan: Boolean(rawEntry.lesson?.presentation?.video),
  })
  const normalizedTopic = String(rawEntry.topic ?? "").trim()
  const normalizedAudience = String(rawEntry.audience ?? normalizedLesson.audience).trim() || normalizedLesson.audience
  const normalizedModel = String(rawEntry.model ?? normalizedLesson.model).trim() || normalizedLesson.model
  const normalizedFolderName =
    String(rawEntry.folderName ?? "").trim() ||
    `${normalizedAudience.toUpperCase()} ${normalizedModel === "edi" ? "lessen" : normalizedModel === "formatief handelen" ? "formatieve lessen" : "lesmateriaal"}`
  const normalizedTags = Array.from(
    new Set(
      [
        ...(Array.isArray(rawEntry.tags) ? rawEntry.tags : []),
        normalizedAudience,
        normalizedModel,
        ...normalizedTopic
          .split(/[,/]| en | met /i)
          .map((part) => String(part || "").trim())
          .filter(Boolean)
          .slice(0, 4),
      ]
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  ).slice(0, 8)

  return {
    id: entryId,
    topic: normalizedTopic,
    title: String(rawEntry.title ?? normalizedLesson.title).trim() || normalizedLesson.title,
    isFavorite: Boolean(rawEntry.isFavorite),
    sectionName: String(rawEntry.sectionName ?? "").trim() || "Algemene sectie",
    ownerUsername: normalizeTeacherUsername(rawEntry.ownerUsername),
    ownerDisplayName: String(rawEntry.ownerDisplayName ?? rawEntry.ownerUsername ?? "Docent").trim() || "Docent",
    folderName: normalizedFolderName,
    tags: normalizedTags,
    audience: normalizedAudience,
    model: normalizedModel,
    durationMinutes: Number(rawEntry.durationMinutes) || normalizedLesson.durationMinutes,
    lessonGoal: String(rawEntry.lessonGoal ?? normalizedLesson.lessonGoal).trim() || normalizedLesson.lessonGoal,
    successCriteria: normalizedLesson.successCriteria,
    materials: normalizedLesson.materials,
    lesson: {
      ...normalizedLesson,
      libraryId: entryId,
      currentPhaseIndex: -1,
    },
    source: String(rawEntry.source ?? "library").trim() || "library",
    providerLabel: String(rawEntry.providerLabel ?? "Lesbibliotheek").trim() || "Lesbibliotheek",
    createdAt: String(rawEntry.createdAt ?? new Date().toISOString()),
    updatedAt: String(rawEntry.updatedAt ?? new Date().toISOString()),
  }
}

function normalizeMathGrowthRecord(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object") return null
  const learnerCode = normalizeLearnerCode(rawEntry.learnerCode)
  const name = String(rawEntry.name ?? "").trim()
  if (!learnerCode || !name) return null
  const sessions = Array.isArray(rawEntry.sessions)
    ? rawEntry.sessions
        .map((entry) => ({
          roomCode: String(entry?.roomCode ?? "").trim().toUpperCase(),
          title: String(entry?.title ?? "").trim(),
          assignmentTitle: String(entry?.assignmentTitle ?? "").trim(),
          selectedBand: normalizeMathLevel(entry?.selectedBand),
          placementLevel: entry?.placementLevel ? normalizeMathLevel(entry.placementLevel) : "",
          targetLevel: entry?.targetLevel ? normalizeMathLevel(entry.targetLevel) : "",
          answeredCount: Number(entry?.answeredCount) || 0,
          correctCount: Number(entry?.correctCount) || 0,
          practiceQuestionCount: Number(entry?.practiceQuestionCount) || 0,
          practiceCorrectCount: Number(entry?.practiceCorrectCount) || 0,
          accuracyRate: Math.max(0, Number(entry?.accuracyRate) || 0),
          updatedAt: normalizeIsoDateTime(entry?.updatedAt) || new Date().toISOString(),
        }))
        .filter((entry) => entry.roomCode)
    : []

  return {
    id: String(rawEntry.id ?? buildMathCloudResumeDocId(name, learnerCode)),
    name,
    learnerCode,
    nameKey: normalizeParticipantName(name),
    sessions,
    createdAt: normalizeIsoDateTime(rawEntry.createdAt) || new Date().toISOString(),
    updatedAt: normalizeIsoDateTime(rawEntry.updatedAt) || new Date().toISOString(),
  }
}

function loadMathGrowthHistory() {
  try {
    ensureSharedDataDir()
    if (!fs.existsSync(mathGrowthHistoryPath)) return new Map()
    const parsed = JSON.parse(fs.readFileSync(mathGrowthHistoryPath, "utf8"))
    if (!Array.isArray(parsed)) return new Map()
    return new Map(parsed.map((entry) => {
      const normalized = normalizeMathGrowthRecord(entry)
      return normalized ? [normalized.id, normalized] : null
    }).filter(Boolean))
  } catch (error) {
    console.error("Kon rekenontwikkeling niet laden:", error instanceof Error ? error.message : error)
    return new Map()
  }
}

function persistMathGrowthHistory() {
  try {
    ensureSharedDataDir()
    fs.writeFileSync(mathGrowthHistoryPath, JSON.stringify([...mathGrowthHistory.values()], null, 2), "utf8")
  } catch (error) {
    console.error("Kon rekenontwikkeling niet opslaan:", error instanceof Error ? error.message : error)
  }
}

function buildMathGrowthSessionSnapshot(room, player, progress) {
  return {
    roomCode: room.code,
    title: room.math?.title || `Rekenroute ${formatMathLevel(room.math?.selectedBand || MATH_LEVELS[1])}`,
    assignmentTitle: room.math?.assignmentTitle || "",
    selectedBand: normalizeMathLevel(room.math?.selectedBand || ""),
    placementLevel: progress?.placementLevel ? normalizeMathLevel(progress.placementLevel) : "",
    targetLevel: progress?.targetLevel ? normalizeMathLevel(progress.targetLevel) : "",
    answeredCount: getMathAnsweredCount(progress),
    correctCount: getMathCorrectCount(progress),
    practiceQuestionCount: Number(progress?.practiceQuestionCount) || 0,
    practiceCorrectCount: Number(progress?.practiceCorrectCount) || 0,
    accuracyRate: getMathAccuracyRate(progress),
    updatedAt: normalizeIsoDateTime(progress?.updatedAt || room.updatedAt) || new Date().toISOString(),
  }
}

function summarizeMathGrowthRecord(record) {
  if (!record) return null
  const sessions = Array.isArray(record.sessions) ? record.sessions : []
  const sessionCount = sessions.length
  const totalAnswered = sessions.reduce((sum, entry) => sum + (Number(entry.answeredCount) || 0), 0)
  const totalCorrect = sessions.reduce((sum, entry) => sum + (Number(entry.correctCount) || 0), 0)
  const averageAccuracy = totalAnswered ? Math.round((totalCorrect / totalAnswered) * 100) : 0
  const latestSession = [...sessions].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())[0] || null
  return {
    sessionCount,
    totalAnswered,
    totalCorrect,
    averageAccuracy,
    lastPracticedAt: latestSession?.updatedAt || record.updatedAt || "",
    lastPlacementLevel: latestSession?.placementLevel ? formatMathLevel(latestSession.placementLevel) : "",
    lastTargetLevel: latestSession?.targetLevel ? formatMathLevel(latestSession.targetLevel) : "",
  }
}

function getMathGrowthSummary(name = "", learnerCode = "") {
  const id = buildMathCloudResumeDocId(name, learnerCode)
  return summarizeMathGrowthRecord(mathGrowthHistory.get(id) || null)
}

function upsertMathGrowthRecord(room, player, progress) {
  if (!player?.name || !isValidLearnerCode(player?.learnerCode)) return null
  const id = buildMathCloudResumeDocId(player.name, player.learnerCode)
  const existing = mathGrowthHistory.get(id) || normalizeMathGrowthRecord({
    id,
    name: player.name,
    learnerCode: player.learnerCode,
    sessions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  const snapshot = buildMathGrowthSessionSnapshot(room, player, progress)
  const nextSessions = [
    snapshot,
    ...((existing?.sessions || []).filter((entry) => entry.roomCode !== room.code)),
  ].slice(0, 16)
  const nextRecord = {
    ...existing,
    id,
    name: player.name,
    learnerCode: player.learnerCode,
    nameKey: normalizeParticipantName(player.name),
    sessions: nextSessions,
    updatedAt: snapshot.updatedAt,
  }
  mathGrowthHistory.set(id, nextRecord)
  persistMathGrowthHistory()
  return nextRecord
}

function buildMathGrowthCloudDocument(record) {
  return {
    fields: {
      name: firestoreStringField(record.name || ""),
      learnerCode: firestoreStringField(record.learnerCode || ""),
      nameKey: firestoreStringField(record.nameKey || ""),
      updatedAt: firestoreStringField(record.updatedAt || new Date().toISOString()),
      snapshotJson: firestoreStringField(JSON.stringify(record)),
    },
  }
}

async function writeMathGrowthRecordToCloud(record) {
  if (!mathCloudEnabled || !record?.id) return
  await firestoreRequest(firestoreDocUrl(MATH_CLOUD_GROWTH_COLLECTION, record.id), {
    method: "PATCH",
    body: buildMathGrowthCloudDocument(record),
  })
}

async function loadMathGrowthRecordFromCloud(name, learnerCode) {
  if (!mathCloudEnabled || !name || !isValidLearnerCode(learnerCode)) return null
  try {
    const document = await firestoreRequest(firestoreDocUrl(MATH_CLOUD_GROWTH_COLLECTION, buildMathCloudResumeDocId(name, learnerCode)))
    const snapshotJson = readFirestoreString(document, "snapshotJson", "")
    if (!snapshotJson) return null
    const record = normalizeMathGrowthRecord(JSON.parse(snapshotJson))
    if (record) {
      mathGrowthHistory.set(record.id, record)
      persistMathGrowthHistory()
    }
    return record
  } catch (error) {
    console.error("Kon rekenontwikkeling niet uit Firestore laden:", error instanceof Error ? error.message : error)
    return null
  }
}

async function ensureMathGrowthRecordLoaded(name, learnerCode) {
  const existing = mathGrowthHistory.get(buildMathCloudResumeDocId(name, learnerCode)) || null
  if (existing) return existing
  return loadMathGrowthRecordFromCloud(name, learnerCode)
}

function syncMathGrowthForPlayer(room, player, progress) {
  const record = upsertMathGrowthRecord(room, player, progress)
  if (!record) return
  if (mathCloudEnabled) {
    writeMathGrowthRecordToCloud(record).catch((error) => {
      console.error("Kon rekenontwikkeling niet naar Firestore schrijven:", error instanceof Error ? error.message : error)
    })
  }
}

async function renameMathGrowthRecord(previousName = "", previousLearnerCode = "", nextName = "", nextLearnerCode = "") {
  const normalizedNextName = String(nextName ?? "").trim()
  const normalizedNextLearnerCode = normalizeLearnerCode(nextLearnerCode)
  if (!normalizedNextName || !isValidLearnerCode(normalizedNextLearnerCode)) return

  const previousId = buildMathCloudResumeDocId(previousName, previousLearnerCode)
  const nextId = buildMathCloudResumeDocId(normalizedNextName, normalizedNextLearnerCode)
  if (!previousId || !nextId || previousId === nextId) return

  let record = mathGrowthHistory.get(previousId) || null
  if (!record) {
    record = await loadMathGrowthRecordFromCloud(previousName, previousLearnerCode)
  }
  if (!record) return

  const migratedRecord = normalizeMathGrowthRecord({
    ...record,
    id: nextId,
    name: normalizedNextName,
    learnerCode: normalizedNextLearnerCode,
    nameKey: normalizeParticipantName(normalizedNextName),
    updatedAt: normalizeIsoDateTime(record.updatedAt) || new Date().toISOString(),
  })
  if (!migratedRecord) return

  mathGrowthHistory.delete(previousId)
  mathGrowthHistory.set(nextId, migratedRecord)
  persistMathGrowthHistory()

  if (!mathCloudEnabled) return
  await writeMathGrowthRecordToCloud(migratedRecord)
  try {
    await firestoreRequest(firestoreDocUrl(MATH_CLOUD_GROWTH_COLLECTION, previousId), {
      method: "DELETE",
    })
  } catch (error) {
    console.error("Kon oude rekenontwikkeling niet uit Firestore verwijderen:", error instanceof Error ? error.message : error)
  }
}

function normalizeSelfPracticeAnswerEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object") return null
  const prompt = String(rawEntry.prompt ?? "").trim()
  const answeredAt = normalizeIsoDateTime(rawEntry.answeredAt) || new Date().toISOString()
  if (!prompt) return null
  return {
    questionId: String(rawEntry.questionId ?? generateEntityId("self-practice-answer")),
    prompt,
    questionType: rawEntry.questionType === "typed" ? "typed" : "multiple-choice",
    answerText: String(rawEntry.answerText ?? "").trim(),
    correctAnswer: String(rawEntry.correctAnswer ?? "").trim(),
    correct: Boolean(rawEntry.correct),
    explanation: String(rawEntry.explanation ?? "").trim(),
    answeredAt,
  }
}

function normalizeSelfPracticeSessionEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object") return null
  const sessionId = String(rawEntry.sessionId ?? rawEntry.id ?? "").trim()
  if (!sessionId) return null
  const answeredCount = Math.max(0, Number(rawEntry.answeredCount) || 0)
  const correctCount = Math.max(0, Number(rawEntry.correctCount) || 0)
  const questionTotal = Math.max(answeredCount, Number(rawEntry.questionTotal) || 0)
  const accuracyRate = answeredCount ? Math.round((correctCount / Math.max(1, answeredCount)) * 100) : 0
  return {
    sessionId,
    title: String(rawEntry.title ?? "Oefentoets").trim() || "Oefentoets",
    topic: String(rawEntry.topic ?? "").trim(),
    topicLabel: cleanSelfPracticeTopicLabel(rawEntry.topicLabel ?? rawEntry.topic ?? ""),
    questionFormat: normalizePracticeQuestionFormat(rawEntry.questionFormat),
    providerLabel: String(rawEntry.providerLabel ?? "Lesson Battle").trim() || "Lesson Battle",
    questionTotal,
    answeredCount,
    correctCount,
    accuracyRate,
    status: rawEntry.status === "finished" ? "finished" : "active",
    startedAt: normalizeIsoDateTime(rawEntry.startedAt) || new Date().toISOString(),
    updatedAt: normalizeIsoDateTime(rawEntry.updatedAt) || new Date().toISOString(),
    finishedAt: normalizeIsoDateTime(rawEntry.finishedAt) || "",
    recentAnswers: Array.isArray(rawEntry.recentAnswers)
      ? rawEntry.recentAnswers.map(normalizeSelfPracticeAnswerEntry).filter(Boolean).slice(-12)
      : [],
  }
}

function normalizeSelfPracticeRecord(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object") return null
  const learnerCode = normalizeLearnerCode(rawEntry.learnerCode)
  const name = String(rawEntry.name ?? "").trim()
  if (!learnerCode || !name) return null
  const sessions = Array.isArray(rawEntry.sessions)
    ? rawEntry.sessions.map(normalizeSelfPracticeSessionEntry).filter(Boolean)
    : []
  return {
    id: String(rawEntry.id ?? buildMathCloudResumeDocId(name, learnerCode)),
    name,
    learnerCode,
    nameKey: normalizeParticipantName(name),
    classId: String(rawEntry.classId ?? "").trim(),
    className: String(rawEntry.className ?? "").trim(),
    audience: String(rawEntry.audience ?? "vmbo").trim() || "vmbo",
    sessions,
    createdAt: normalizeIsoDateTime(rawEntry.createdAt) || new Date().toISOString(),
    updatedAt: normalizeIsoDateTime(rawEntry.updatedAt) || new Date().toISOString(),
  }
}

function loadSelfPracticeHistory() {
  try {
    ensureSharedDataDir()
    if (!fs.existsSync(selfPracticeHistoryPath)) return new Map()
    const parsed = JSON.parse(fs.readFileSync(selfPracticeHistoryPath, "utf8"))
    if (!Array.isArray(parsed)) return new Map()
    return new Map(
      parsed
        .map((entry) => {
          const normalized = normalizeSelfPracticeRecord(entry)
          return normalized ? [normalized.id, normalized] : null
        })
        .filter(Boolean)
    )
  } catch (error) {
    console.error("Kon zelfstandige oefentoetsen niet laden:", error instanceof Error ? error.message : error)
    return new Map()
  }
}

function persistSelfPracticeHistory() {
  try {
    ensureSharedDataDir()
    fs.writeFileSync(selfPracticeHistoryPath, JSON.stringify([...selfPracticeHistory.values()], null, 2), "utf8")
  } catch (error) {
    console.error("Kon zelfstandige oefentoetsen niet opslaan:", error instanceof Error ? error.message : error)
  }
}

function summarizeSelfPracticeRecord(record) {
  if (!record) return null
  const sessions = Array.isArray(record.sessions) ? [...record.sessions] : []
  if (!sessions.length) return null
  const sortedSessions = sessions.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
  const latestSession = sortedSessions[0] || null
  const totalAnswered = sortedSessions.reduce((sum, entry) => sum + (Number(entry.answeredCount) || 0), 0)
  const totalCorrect = sortedSessions.reduce((sum, entry) => sum + (Number(entry.correctCount) || 0), 0)
  const averageAccuracy = totalAnswered ? Math.round((totalCorrect / Math.max(1, totalAnswered)) * 100) : 0
  return {
    sessionCount: sortedSessions.length,
    totalAnswered,
    totalCorrect,
    averageAccuracy,
    lastPracticedAt: latestSession?.updatedAt || record.updatedAt || "",
    latestSession: latestSession
      ? {
          sessionId: latestSession.sessionId,
          title: latestSession.title,
          topicLabel: latestSession.topicLabel,
          questionFormat: latestSession.questionFormat,
          status: latestSession.status,
          questionTotal: latestSession.questionTotal,
          answeredCount: latestSession.answeredCount,
          correctCount: latestSession.correctCount,
          accuracyRate: latestSession.accuracyRate,
          updatedAt: latestSession.updatedAt,
          finishedAt: latestSession.finishedAt,
          recentAnswers: latestSession.recentAnswers || [],
        }
      : null,
    recentSessions: sortedSessions.slice(0, 3).map((session) => ({
      sessionId: session.sessionId,
      title: session.title,
      topicLabel: session.topicLabel,
      questionFormat: session.questionFormat,
      status: session.status,
      questionTotal: session.questionTotal,
      answeredCount: session.answeredCount,
      correctCount: session.correctCount,
      accuracyRate: session.accuracyRate,
      updatedAt: session.updatedAt,
      finishedAt: session.finishedAt,
    })),
  }
}

function getSelfPracticeSummary(name = "", learnerCode = "") {
  const id = buildMathCloudResumeDocId(name, learnerCode)
  return summarizeSelfPracticeRecord(selfPracticeHistory.get(id) || null)
}

function buildSelfPracticeCloudDocument(record) {
  return {
    fields: {
      name: firestoreStringField(record.name || ""),
      learnerCode: firestoreStringField(record.learnerCode || ""),
      nameKey: firestoreStringField(record.nameKey || ""),
      updatedAt: firestoreStringField(record.updatedAt || new Date().toISOString()),
      snapshotJson: firestoreStringField(JSON.stringify(record)),
    },
  }
}

async function writeSelfPracticeRecordToCloud(record) {
  if (!mathCloudEnabled || !record?.id) return
  await firestoreRequest(firestoreDocUrl(SELF_PRACTICE_CLOUD_COLLECTION, record.id), {
    method: "PATCH",
    body: buildSelfPracticeCloudDocument(record),
  })
}

async function loadSelfPracticeHistoryFromCloud() {
  if (!mathCloudEnabled) return new Map()
  try {
    const payload = await firestoreRequest(`${firestoreCollectionUrl(SELF_PRACTICE_CLOUD_COLLECTION)}?pageSize=400`)
    const documents = Array.isArray(payload?.documents) ? payload.documents : []
    return new Map(
      documents
        .map((document) => {
          const snapshotJson = readFirestoreString(document, "snapshotJson", "")
          if (!snapshotJson) return null
          try {
            const normalized = normalizeSelfPracticeRecord(JSON.parse(snapshotJson))
            return normalized ? [normalized.id, normalized] : null
          } catch (error) {
            console.error("Kon zelfstandige oefentoets uit Firestore niet parsen:", error instanceof Error ? error.message : error)
            return null
          }
        })
        .filter(Boolean)
    )
  } catch (error) {
    console.error("Kon zelfstandige oefentoetsen niet uit Firestore laden:", error instanceof Error ? error.message : error)
    return new Map()
  }
}

async function ensureSelfPracticeHistoryHydratedFromCloud() {
  if (!mathCloudEnabled) return selfPracticeHistory
  if (selfPracticeCloudHydrationPromise) return selfPracticeCloudHydrationPromise

  selfPracticeCloudHydrationPromise = (async () => {
    const cloudRecords = await loadSelfPracticeHistoryFromCloud()
    if (cloudRecords.size) {
      const mergedRecords = new Map(selfPracticeHistory)
      for (const [id, record] of cloudRecords.entries()) {
        const localRecord = mergedRecords.get(id) || null
        if (!localRecord || new Date(record.updatedAt).getTime() >= new Date(localRecord.updatedAt).getTime()) {
          mergedRecords.set(id, record)
        }
      }
      selfPracticeHistory = mergedRecords
      persistSelfPracticeHistory()
      return selfPracticeHistory
    }

    if (selfPracticeHistory.size) {
      await Promise.all(
        [...selfPracticeHistory.values()].map((record) =>
          writeSelfPracticeRecordToCloud(record).catch((error) => {
            console.error("Kon bestaande oefentoetsrecord niet naar Firestore schrijven:", error instanceof Error ? error.message : error)
          })
        )
      )
    }
    return selfPracticeHistory
  })().finally(() => {
    selfPracticeCloudHydrationPromise = null
  })

  return selfPracticeCloudHydrationPromise
}

function upsertSelfPracticeSession(profile = {}, sessionEntry = {}) {
  const normalizedLearnerCode = normalizeLearnerCode(profile.learnerCode)
  const trimmedName = String(profile.name ?? "").trim()
  const normalizedSession = normalizeSelfPracticeSessionEntry(sessionEntry)
  if (!trimmedName || !isValidLearnerCode(normalizedLearnerCode) || !normalizedSession) return null

  const id = buildMathCloudResumeDocId(trimmedName, normalizedLearnerCode)
  const existing =
    selfPracticeHistory.get(id) ||
    normalizeSelfPracticeRecord({
      id,
      name: trimmedName,
      learnerCode: normalizedLearnerCode,
      classId: profile.classId || "",
      className: profile.className || "",
      audience: profile.audience || "vmbo",
      sessions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  const nextSessions = [
    normalizedSession,
    ...((existing?.sessions || []).filter((entry) => entry.sessionId !== normalizedSession.sessionId)),
  ]
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, 20)
  const nextRecord = {
    ...existing,
    id,
    name: trimmedName,
    learnerCode: normalizedLearnerCode,
    nameKey: normalizeParticipantName(trimmedName),
    classId: String(profile.classId || existing?.classId || "").trim(),
    className: String(profile.className || existing?.className || "").trim(),
    audience: String(profile.audience || existing?.audience || "vmbo").trim() || "vmbo",
    sessions: nextSessions,
    updatedAt: normalizedSession.updatedAt,
  }

  selfPracticeHistory.set(id, nextRecord)
  persistSelfPracticeHistory()
  if (mathCloudEnabled) {
    writeSelfPracticeRecordToCloud(nextRecord).catch((error) => {
      console.error("Kon zelfstandige oefentoets niet naar Firestore schrijven:", error instanceof Error ? error.message : error)
    })
  }
  emitClassroomsToHosts()
  return nextRecord
}

async function renameSelfPracticeRecord(previousName = "", previousLearnerCode = "", nextName = "", nextLearnerCode = "") {
  const normalizedNextName = String(nextName ?? "").trim()
  const normalizedNextLearnerCode = normalizeLearnerCode(nextLearnerCode)
  if (!normalizedNextName || !isValidLearnerCode(normalizedNextLearnerCode)) return

  const previousId = buildMathCloudResumeDocId(previousName, previousLearnerCode)
  const nextId = buildMathCloudResumeDocId(normalizedNextName, normalizedNextLearnerCode)
  if (!previousId || !nextId || previousId === nextId) return

  const existing = selfPracticeHistory.get(previousId) || null
  if (!existing) return

  const migratedRecord = normalizeSelfPracticeRecord({
    ...existing,
    id: nextId,
    name: normalizedNextName,
    learnerCode: normalizedNextLearnerCode,
    nameKey: normalizeParticipantName(normalizedNextName),
    updatedAt: normalizeIsoDateTime(existing.updatedAt) || new Date().toISOString(),
  })
  if (!migratedRecord) return

  selfPracticeHistory.delete(previousId)
  selfPracticeHistory.set(nextId, migratedRecord)
  persistSelfPracticeHistory()

  if (!mathCloudEnabled) return
  await writeSelfPracticeRecordToCloud(migratedRecord)
  try {
    await firestoreRequest(firestoreDocUrl(SELF_PRACTICE_CLOUD_COLLECTION, previousId), {
      method: "DELETE",
    })
  } catch (error) {
    console.error("Kon oud oefentoetsrecord niet uit Firestore verwijderen:", error instanceof Error ? error.message : error)
  }
}

function normalizeTeacherAccount(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object") return null
  const username = normalizeTeacherUsername(rawEntry.username)
  if (!username || !rawEntry.passwordHash || !rawEntry.salt) return null

  return {
    id: String(rawEntry.id ?? generateEntityId("teacher")),
    username,
    displayName: String(rawEntry.displayName ?? rawEntry.username ?? username).trim() || username,
    salt: String(rawEntry.salt),
    passwordHash: String(rawEntry.passwordHash),
    role: rawEntry.role === "manager" ? "manager" : "teacher",
    createdAt: String(rawEntry.createdAt ?? new Date().toISOString()),
    updatedAt: String(rawEntry.updatedAt ?? new Date().toISOString()),
  }
}

function normalizeClassroomLearner(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object") return null
  const name = String(rawEntry.name ?? "").trim()
  const learnerCode = normalizeLearnerCode(rawEntry.learnerCode)
  const studentNumber = normalizeStudentNumber(rawEntry.studentNumber)
  if (!name || !isValidLearnerCode(learnerCode)) return null
  return {
    id: String(rawEntry.id ?? generateEntityId("class-learner")),
    name,
    learnerCode,
    studentNumber,
    createdAt: String(rawEntry.createdAt ?? new Date().toISOString()),
    updatedAt: String(rawEntry.updatedAt ?? new Date().toISOString()),
  }
}

function normalizeClassroomEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object") return null
  const name = String(rawEntry.name ?? "").trim()
  if (!name) return null
  const learners = Array.isArray(rawEntry.learners)
    ? rawEntry.learners.map(normalizeClassroomLearner).filter(Boolean)
    : []
  return {
    id: String(rawEntry.id ?? generateEntityId("classroom")),
    name,
    sectionName: String(rawEntry.sectionName ?? "").trim() || "Algemene sectie",
    audience: String(rawEntry.audience ?? "vmbo").trim() || "vmbo",
    ownerUsername: normalizeTeacherUsername(rawEntry.ownerUsername),
    ownerDisplayName: String(rawEntry.ownerDisplayName ?? rawEntry.ownerUsername ?? "Docent").trim() || "Docent",
    learners,
    createdAt: String(rawEntry.createdAt ?? new Date().toISOString()),
    updatedAt: String(rawEntry.updatedAt ?? new Date().toISOString()),
  }
}

function loadTeacherAccounts() {
  try {
    ensureSharedDataDir()
    if (!fs.existsSync(teacherAccountsPath)) return []
    const parsed = JSON.parse(fs.readFileSync(teacherAccountsPath, "utf8"))
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalizeTeacherAccount).filter(Boolean)
  } catch (error) {
    console.error("Kon docentaccounts niet laden:", error instanceof Error ? error.message : error)
    return []
  }
}

let teacherAccounts = loadTeacherAccounts()

function persistTeacherAccounts() {
  try {
    ensureSharedDataDir()
    fs.writeFileSync(teacherAccountsPath, JSON.stringify(teacherAccounts, null, 2), "utf8")
  } catch (error) {
    console.error("Kon docentaccounts niet opslaan:", error instanceof Error ? error.message : error)
    throw new Error("Opslaan van docentaccounts is mislukt.")
  }
}

function loadClassrooms() {
  try {
    ensureSharedDataDir()
    if (!fs.existsSync(classroomsPath)) return []
    const parsed = JSON.parse(fs.readFileSync(classroomsPath, "utf8"))
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalizeClassroomEntry).filter(Boolean)
  } catch (error) {
    console.error("Kon klassen niet laden:", error instanceof Error ? error.message : error)
    return []
  }
}

let classrooms = loadClassrooms()

if (mathCloudEnabled) {
  ensureSelfPracticeHistoryHydratedFromCloud().catch((error) => {
    console.error("Kon oefentoetsbootstrap uit Firestore niet afronden:", error instanceof Error ? error.message : error)
  })
  ensureClassroomsHydratedFromCloud().catch((error) => {
    console.error("Kon klassenbootstrap uit Firestore niet afronden:", error instanceof Error ? error.message : error)
  })
}

function persistClassrooms() {
  try {
    ensureSharedDataDir()
    fs.writeFileSync(classroomsPath, JSON.stringify(classrooms, null, 2), "utf8")
  } catch (error) {
    console.error("Kon klassen niet opslaan:", error instanceof Error ? error.message : error)
    throw new Error("Opslaan van klassen is mislukt.")
  }
}

function buildClassroomCloudDocument(classroom) {
  return {
    fields: {
      name: firestoreStringField(classroom?.name || ""),
      sectionName: firestoreStringField(classroom?.sectionName || ""),
      audience: firestoreStringField(classroom?.audience || ""),
      ownerUsername: firestoreStringField(classroom?.ownerUsername || ""),
      ownerDisplayName: firestoreStringField(classroom?.ownerDisplayName || ""),
      updatedAt: firestoreStringField(classroom?.updatedAt || new Date().toISOString()),
      snapshotJson: firestoreStringField(JSON.stringify(classroom)),
    },
  }
}

async function writeClassroomToCloud(classroom) {
  if (!mathCloudEnabled || !classroom?.id) return
  await firestoreRequest(firestoreDocUrl(CLASSROOM_CLOUD_COLLECTION, classroom.id), {
    method: "PATCH",
    body: buildClassroomCloudDocument(classroom),
  })
}

async function removeClassroomFromCloud(classroomId = "") {
  if (!mathCloudEnabled || !classroomId) return
  try {
    await firestoreRequest(firestoreDocUrl(CLASSROOM_CLOUD_COLLECTION, classroomId), {
      method: "DELETE",
    })
  } catch (error) {
    if (!String(error instanceof Error ? error.message : error).includes("404")) {
      console.error("Kon klas niet uit Firestore verwijderen:", error instanceof Error ? error.message : error)
    }
  }
}

async function loadClassroomsFromCloud() {
  if (!mathCloudEnabled) return []
  try {
    const payload = await firestoreRequest(`${firestoreCollectionUrl(CLASSROOM_CLOUD_COLLECTION)}?pageSize=200`)
    const documents = Array.isArray(payload?.documents) ? payload.documents : []
    return documents
      .map((document) => {
        const snapshotJson = readFirestoreString(document, "snapshotJson", "")
        if (!snapshotJson) return null
        try {
          return normalizeClassroomEntry(JSON.parse(snapshotJson))
        } catch (error) {
          console.error("Kon klas uit Firestore niet parsen:", error instanceof Error ? error.message : error)
          return null
        }
      })
      .filter(Boolean)
  } catch (error) {
    console.error("Kon klassen niet uit Firestore laden:", error instanceof Error ? error.message : error)
    return []
  }
}

async function ensureClassroomsHydratedFromCloud() {
  if (!mathCloudEnabled) return classrooms
  if (classroomsCloudHydrationPromise) return classroomsCloudHydrationPromise

  classroomsCloudHydrationPromise = (async () => {
    await ensureSelfPracticeHistoryHydratedFromCloud()
    const cloudClassrooms = await loadClassroomsFromCloud()
    if (cloudClassrooms.length) {
      classrooms = cloudClassrooms
      persistClassrooms()
      emitClassroomsToHosts()
      return classrooms
    }

    if (classrooms.length) {
      await Promise.all(
        classrooms.map((classroom) =>
          writeClassroomToCloud(classroom).catch((error) => {
            console.error("Kon bestaande klas niet naar Firestore schrijven:", error instanceof Error ? error.message : error)
          })
        )
      )
    }
    return classrooms
  })().finally(() => {
    classroomsCloudHydrationPromise = null
  })

  return classroomsCloudHydrationPromise
}

function classroomSummaries() {
  return [...classrooms]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      sectionName: entry.sectionName,
      audience: entry.audience,
      ownerUsername: entry.ownerUsername,
      ownerDisplayName: entry.ownerDisplayName,
      learnerCount: entry.learners.length,
      learners: entry.learners.map((learner) => ({
        id: learner.id,
        name: learner.name,
        learnerCode: learner.learnerCode,
        studentNumber: learner.studentNumber || "",
        selfPracticeSummary: getSelfPracticeSummary(learner.name, learner.learnerCode),
        createdAt: learner.createdAt,
        updatedAt: learner.updatedAt,
      })),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }))
}

function findClassroomLearnerByCredentials(name = "", learnerCode = "") {
  const normalizedName = normalizeParticipantName(name)
  const normalizedCode = normalizeLearnerCode(learnerCode)
  if (!normalizedName || !isValidLearnerCode(normalizedCode)) return { classroom: null, learner: null }

  for (const classroom of classrooms) {
    const learner =
      classroom.learners.find(
        (entry) =>
          entry.learnerCode === normalizedCode &&
          normalizeParticipantName(entry.name || "") === normalizedName
      ) || null
    if (learner) return { classroom, learner }
  }

  return { classroom: null, learner: null }
}

function resolveLearnerPortalProfile(name = "", learnerCode = "") {
  const trimmedName = String(name ?? "").trim()
  const normalizedCode = normalizeLearnerCode(learnerCode)
  if (!trimmedName || !isValidLearnerCode(normalizedCode)) return null

  const { classroom, learner } = findClassroomLearnerByCredentials(trimmedName, normalizedCode)
  const growthSummary = getMathGrowthSummary(trimmedName, normalizedCode)
  const selfPracticeSummary = getSelfPracticeSummary(trimmedName, normalizedCode)

  if (!learner && !growthSummary && !selfPracticeSummary) return null

  return {
    name: learner?.name || trimmedName,
    learnerCode: normalizedCode,
    classId: classroom?.id || "",
    className: classroom?.name || "",
    sectionName: classroom?.sectionName || "",
    audience: classroom?.audience || "vmbo",
    canResumeMath: Boolean(growthSummary?.sessionCount),
    growthSummary: growthSummary || null,
    selfPracticeSummary: selfPracticeSummary || null,
  }
}

function emitClassroomsToSocket(socket) {
  socket.emit("host:classes:update", { classrooms: classroomSummaries() })
}

function emitClassroomsToHosts() {
  for (const socketId of hostSocketIds) {
    io.to(socketId).emit("host:classes:update", { classrooms: classroomSummaries() })
  }
}

function findClassroomById(classId = "") {
  return classrooms.find((entry) => entry.id === String(classId ?? "").trim()) || null
}

function mergeImportedLearnersIntoClassroom(classroom, importedLearners = []) {
  const now = new Date().toISOString()
  const nextLearners = (classroom?.learners || []).map((learner) => ({ ...learner }))
  const codeOwnerMap = new Map()
  const studentNumberOwnerMap = new Map()

  for (const learner of nextLearners) {
    if (learner.learnerCode) codeOwnerMap.set(learner.learnerCode, learner.id)
    if (learner.studentNumber) studentNumberOwnerMap.set(learner.studentNumber, learner.id)
  }

  let addedCount = 0
  let updatedCount = 0
  let skippedCount = 0

  for (const importedLearner of importedLearners) {
    const trimmedName = String(importedLearner?.name || "").trim()
    if (!trimmedName) {
      skippedCount += 1
      continue
    }

    const importedCode = normalizeLearnerCode(importedLearner?.learnerCode)
    const importedStudentNumber = normalizeStudentNumber(importedLearner?.studentNumber)
    const matchedLearner =
      (importedStudentNumber
        ? nextLearners.find((learner) => normalizeStudentNumber(learner.studentNumber) === importedStudentNumber)
        : null) ||
      (importedCode ? nextLearners.find((learner) => learner.learnerCode === importedCode) : null) ||
      nextLearners.find((learner) => normalizeParticipantName(learner.name) === normalizeParticipantName(trimmedName)) ||
      null

    if (matchedLearner) {
      const nextCodeCandidate =
        importedCode && (!codeOwnerMap.has(importedCode) || codeOwnerMap.get(importedCode) === matchedLearner.id)
          ? importedCode
          : matchedLearner.learnerCode
      const nextStudentNumberCandidate =
        importedStudentNumber &&
        (!studentNumberOwnerMap.has(importedStudentNumber) || studentNumberOwnerMap.get(importedStudentNumber) === matchedLearner.id)
          ? importedStudentNumber
          : normalizeStudentNumber(matchedLearner.studentNumber)
      const nextCode = isValidLearnerCode(nextCodeCandidate)
        ? nextCodeCandidate
        : generateUniqueClassroomLearnerCode({ learners: nextLearners.filter((learner) => learner.id !== matchedLearner.id) }, codeOwnerMap.keys())
      const nextStudentNumber =
        nextStudentNumberCandidate ||
        generateNextStudentNumber(
          nextLearners
            .filter((learner) => learner.id !== matchedLearner.id)
            .map((learner) => learner.studentNumber)
            .concat([...studentNumberOwnerMap.keys()].filter(Boolean))
        )

      const changed =
        matchedLearner.name !== trimmedName ||
        matchedLearner.learnerCode !== nextCode ||
        normalizeStudentNumber(matchedLearner.studentNumber) !== nextStudentNumber

      if (!changed) {
        skippedCount += 1
        continue
      }

      codeOwnerMap.delete(matchedLearner.learnerCode)
      if (matchedLearner.studentNumber) studentNumberOwnerMap.delete(matchedLearner.studentNumber)

      matchedLearner.name = trimmedName
      matchedLearner.learnerCode = nextCode
      matchedLearner.studentNumber = nextStudentNumber
      matchedLearner.updatedAt = now

      codeOwnerMap.set(nextCode, matchedLearner.id)
      studentNumberOwnerMap.set(nextStudentNumber, matchedLearner.id)
      updatedCount += 1
      continue
    }

    const nextCode =
      isValidLearnerCode(importedCode) && !codeOwnerMap.has(importedCode)
        ? importedCode
        : generateUniqueClassroomLearnerCode({ learners: nextLearners }, codeOwnerMap.keys())
    const nextStudentNumber =
      importedStudentNumber && !studentNumberOwnerMap.has(importedStudentNumber)
        ? importedStudentNumber
        : generateNextStudentNumber(nextLearners.map((learner) => learner.studentNumber).concat([...studentNumberOwnerMap.keys()]))
    const nextLearner = normalizeClassroomLearner({
      id: generateEntityId("class-learner"),
      name: trimmedName,
      learnerCode: nextCode,
      studentNumber: nextStudentNumber,
      createdAt: now,
      updatedAt: now,
    })
    if (!nextLearner) {
      skippedCount += 1
      continue
    }
    nextLearners.push(nextLearner)
    codeOwnerMap.set(nextCode, nextLearner.id)
    studentNumberOwnerMap.set(nextStudentNumber, nextLearner.id)
    addedCount += 1
  }

  return {
    nextLearners,
    addedCount,
    updatedCount,
    skippedCount,
  }
}

function updateClassroomInMemory(classroomId, updater) {
  const index = classrooms.findIndex((entry) => entry.id === String(classroomId ?? "").trim())
  if (index === -1) return null
  const nextClassroom = normalizeClassroomEntry(
    typeof updater === "function" ? updater(classrooms[index]) : updater
  )
  if (!nextClassroom) return null
  classrooms[index] = nextClassroom
  persistClassrooms()
  emitClassroomsToHosts()
  if (mathCloudEnabled) {
    writeClassroomToCloud(nextClassroom).catch((error) => {
      console.error("Kon klas niet naar Firestore schrijven:", error instanceof Error ? error.message : error)
    })
  }
  return nextClassroom
}

async function syncClassroomLearnerAcrossMathRooms(classroom, learner, previousName = "", previousLearnerCode = "") {
  if (!classroom?.id || !learner?.id) return
  for (const room of rooms.values()) {
    if (room.game.mode !== "math" || room.math?.classId !== classroom.id) continue
    const matchingPlayer = room.players.find((player) => player.classLearnerId === learner.id)
    if (!matchingPlayer) continue
    matchingPlayer.name = learner.name
    matchingPlayer.learnerCode = learner.learnerCode
    matchingPlayer.classId = classroom.id
    matchingPlayer.className = classroom.name
    if (room.math) {
      room.math.classId = classroom.id
      room.math.className = classroom.name
    }
    const progress = ensureMathProgress(room, matchingPlayer.id)
    syncMathGrowthForPlayer(room, matchingPlayer, progress)
    await syncMathResumeIndexForPlayer(room, matchingPlayer)
    if (matchingPlayer.socketId) {
      io.to(matchingPlayer.socketId).emit("player:profile:update", {
        playerId: matchingPlayer.id,
        learnerCode: matchingPlayer.learnerCode,
      })
    }
    schedulePersistActiveRooms()
    schedulePersistMathRoomToCloud(room)
    emitStateToRoom(room)
  }
}

async function migrateClassroomLearnerIdentity(previousName = "", previousLearnerCode = "", nextName = "", nextLearnerCode = "") {
  const normalizedPreviousCode = normalizeLearnerCode(previousLearnerCode)
  const normalizedNextCode = normalizeLearnerCode(nextLearnerCode)
  const trimmedPreviousName = String(previousName ?? "").trim()
  const trimmedNextName = String(nextName ?? "").trim()
  const changedIdentity =
    normalizeParticipantName(trimmedPreviousName) !== normalizeParticipantName(trimmedNextName) ||
    normalizedPreviousCode !== normalizedNextCode

  if (!trimmedNextName || !isValidLearnerCode(normalizedNextCode)) return
  if (changedIdentity && trimmedPreviousName && isValidLearnerCode(normalizedPreviousCode)) {
    await removeMathResumeIndex(trimmedPreviousName, normalizedPreviousCode)
    await renameMathGrowthRecord(trimmedPreviousName, normalizedPreviousCode, trimmedNextName, normalizedNextCode)
    await renameSelfPracticeRecord(trimmedPreviousName, normalizedPreviousCode, trimmedNextName, normalizedNextCode)
  } else {
    await ensureMathGrowthRecordLoaded(trimmedNextName, normalizedNextCode)
  }
}

function syncClassroomMetaAcrossMathRooms(classroom) {
  if (!classroom?.id) return
  for (const room of rooms.values()) {
    if (room.game.mode !== "math" || room.math?.classId !== classroom.id) continue
    room.math.className = classroom.name
    room.game.topic = `${classroom.name} · Rekenen ${formatMathLevel(room.math?.selectedBand || MATH_LEVELS[1])}`
    room.players = room.players.map((player) =>
      player.classId === classroom.id
        ? {
            ...player,
            className: classroom.name,
          }
        : player
    )
    schedulePersistActiveRooms()
    schedulePersistMathRoomToCloud(room)
    emitStateToRoom(room)
  }
}

function detachClassroomFromMathRooms(classroom) {
  if (!classroom?.id) return
  for (const room of rooms.values()) {
    if (room.game.mode !== "math" || room.math?.classId !== classroom.id) continue
    room.math.classId = ""
    room.math.className = ""
    room.game.topic = `Rekenen ${formatMathLevel(room.math?.selectedBand || MATH_LEVELS[1])}`
    room.players = room.players.map((player) =>
      player.classId === classroom.id
        ? {
            ...player,
            classId: "",
            className: "",
            classLearnerId: "",
          }
        : player
    )
    schedulePersistActiveRooms()
    schedulePersistMathRoomToCloud(room)
    emitStateToRoom(room)
  }
}

function teacherAccountSummaries() {
  return [...teacherAccounts]
    .sort((left, right) => left.username.localeCompare(right.username))
    .map((account) => ({
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    }))
}

function emitTeacherAccountsToSocket(socket) {
  if (!canManageTeacherAccounts(socket.id)) return
  socket.emit("host:teacher-accounts:update", { accounts: teacherAccountSummaries() })
}

function emitTeacherAccountsToOwners() {
  for (const socketId of hostSocketIds) {
    if (!canManageTeacherAccounts(socketId)) continue
    io.to(socketId).emit("host:teacher-accounts:update", { accounts: teacherAccountSummaries() })
  }
}

function authenticateTeacherAccount(username, password) {
  const normalizedUsername = normalizeTeacherUsername(username)
  if (!normalizedUsername) return null

  if (
    normalizedUsername === normalizeTeacherUsername(teacherUsername) &&
    String(password ?? "") === teacherPassword
  ) {
    return {
      username: normalizeTeacherUsername(teacherUsername),
      displayName: teacherUsername,
      role: "owner",
      canManageAccounts: true,
      source: "env",
    }
  }

  const account = teacherAccounts.find((entry) => entry.username === normalizedUsername)
  if (!account || !verifyTeacherPassword(password, account)) return null

  return {
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    canManageAccounts: account.role === "manager",
    source: "stored",
  }
}

function ensureLessonLibraryDir() {
  ensureSharedDataDir()
}

function loadLessonLibrary() {
  try {
    ensureLessonLibraryDir()
    if (!fs.existsSync(lessonLibraryPath)) return []
    const parsed = JSON.parse(fs.readFileSync(lessonLibraryPath, "utf8"))
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalizeLessonLibraryEntry).filter(Boolean)
  } catch (error) {
    console.error("Kon lesbibliotheek niet laden:", error instanceof Error ? error.message : error)
    return []
  }
}

let lessonLibrary = loadLessonLibrary()
mathGrowthHistory = loadMathGrowthHistory()
selfPracticeHistory = loadSelfPracticeHistory()

function persistLessonLibrary() {
  try {
    ensureLessonLibraryDir()
    fs.writeFileSync(lessonLibraryPath, JSON.stringify(lessonLibrary, null, 2), "utf8")
  } catch (error) {
    console.error("Kon lesbibliotheek niet opslaan:", error instanceof Error ? error.message : error)
    throw new Error("Opslaan van de lesbibliotheek is mislukt.")
  }
}

function lessonLibrarySummaries() {
  return [...lessonLibrary]
    .sort((left, right) => {
      if (Boolean(right.isFavorite) !== Boolean(left.isFavorite)) return Number(Boolean(right.isFavorite)) - Number(Boolean(left.isFavorite))
      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    })
    .map((entry) => ({
      id: entry.id,
      topic: entry.topic,
      title: entry.title,
      isFavorite: Boolean(entry.isFavorite),
      sectionName: entry.sectionName || "",
      ownerDisplayName: entry.ownerDisplayName || "",
      folderName: entry.folderName || "",
      tags: [...(entry.tags || [])],
      audience: entry.audience,
      model: entry.model,
      durationMinutes: entry.durationMinutes,
      lessonGoal: entry.lessonGoal,
      phaseCount: entry.lesson.phases.length,
      practiceQuestionCount: entry.lesson.practiceTest?.questions?.length || 0,
      slideCount: entry.lesson.presentation?.slides?.length || 0,
      updatedAt: entry.updatedAt,
      providerLabel: entry.providerLabel,
    }))
}

function emitLessonLibraryToSocket(socket) {
  socket.emit("host:lesson-library:update", { lessons: lessonLibrarySummaries() })
}

function emitLessonLibraryToHosts() {
  for (const socketId of hostSocketIds) {
    io.to(socketId).emit("host:lesson-library:update", { lessons: lessonLibrarySummaries() })
  }
}

function cloneLessonForRoom(lesson, libraryId = null) {
  return {
    ...createEmptyLessonState(),
    ...lesson,
    libraryId,
    successCriteria: [...(lesson.successCriteria || [])],
    materials: [...(lesson.materials || [])],
    phases: (lesson.phases || []).map((phase) => ({ ...phase })),
    activeKeywords: [...(lesson.activeKeywords || [])],
    practiceTest: lesson.practiceTest
      ? {
          ...lesson.practiceTest,
          questions: (lesson.practiceTest.questions || []).map((question) => ({
            ...question,
            options: [...(question.options || [])],
            acceptedAnswers: [...(question.acceptedAnswers || [])],
          })),
        }
      : null,
    presentation: lesson.presentation
      ? {
          ...lesson.presentation,
          slides: (lesson.presentation.slides || []).map((slide) => ({
            ...slide,
            bullets: [...(slide.bullets || [])],
          })),
          video: lesson.presentation.video
            ? {
                ...lesson.presentation.video,
                scenes: (lesson.presentation.video.scenes || []).map((scene) => ({ ...scene })),
              }
            : null,
        }
      : null,
  }
}

function collectManualImageUrlsFromLesson(lesson) {
  const slideUrls =
    lesson?.presentation?.slides?.length
      ? lesson.presentation.slides.map((slide) => sanitizeManualImageUrl(slide?.manualImageUrl || "")).filter(Boolean)
      : []
  const practiceUrls = collectManualImageUrlsFromQuestions(lesson?.practiceTest?.questions || [])
  return [...slideUrls, ...practiceUrls]
}

function isManualImageUrlStillReferenced(targetUrl = "") {
  const normalizedTarget = sanitizeManualImageUrl(targetUrl)
  if (!normalizedTarget || !isLocalManualImageUrl(normalizedTarget)) return false

  for (const room of rooms.values()) {
    if (collectManualImageUrlsFromLesson(room.lesson).includes(normalizedTarget)) return true
    if (collectManualImageUrlsFromQuestions(room.questions).includes(normalizedTarget)) return true
  }

  for (const entry of lessonLibrary) {
    if (collectManualImageUrlsFromLesson(entry.lesson).includes(normalizedTarget)) return true
  }

  for (const entry of sessionHistory) {
    if (collectManualImageUrlsFromLesson(entry.lesson).includes(normalizedTarget)) return true
  }

  return false
}

function removeManualImageFileIfUnused(targetUrl = "") {
  const normalizedTarget = sanitizeManualImageUrl(targetUrl)
  if (!normalizedTarget || !isLocalManualImageUrl(normalizedTarget)) return
  if (isManualImageUrlStillReferenced(normalizedTarget)) return

  const filePath = manualImageFilePathFromUrl(normalizedTarget)
  if (!filePath) return

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch (error) {
    console.warn("[manual-images] cleanup failed:", error instanceof Error ? error.message : error)
  }
}

function cloneQuestionForStorage(question = {}) {
  const prompt = String(question?.prompt || question?.question_text || "").trim()
  const category = String(question?.category || "").trim() || "Quiz"
  const imagePrompt = ensureQuestionImagePrompt(prompt, category, question?.imagePrompt)
  const imageAlt = String(question?.imageAlt || "").trim() || prompt || "Vraagafbeelding"

  return {
    ...question,
    prompt,
    question_text: prompt,
    category,
    imagePrompt,
    imageAlt,
    imageUrl: buildSignedImageUrl({
      prompt: imagePrompt,
      category,
      kind: "question",
    }),
    manualImageUrl: sanitizeManualImageUrl(question?.manualImageUrl || ""),
    manualImageSourceUrl: String(question?.manualImageSourceUrl || "").trim(),
    manualImageSourceImageUrl: String(question?.manualImageSourceImageUrl || "").trim(),
    manualImageSearchQuery: String(question?.manualImageSearchQuery || "").trim(),
    manualImageSourceTitle: String(question?.manualImageSourceTitle || "").trim(),
    manualImageSearchAttempt: Math.max(0, Number(question?.manualImageSearchAttempt) || 0),
    manualImageSourceHistory: sanitizeImageSourceHistory(question?.manualImageSourceHistory || []),
    options: [...(question?.options || [])],
    acceptedAnswers: [...(question?.acceptedAnswers || [])],
  }
}

function cloneQuestionsForStorage(questions = []) {
  return (questions || []).map((question) => cloneQuestionForStorage(question))
}

function detectSessionCategory(topic, type = "lesson") {
  const source = String(topic || "").toLowerCase()
  if (/(economie|pincode|bank|geld|verzekering|werk|markt|productie|loon|omzet|rente)/.test(source)) return "Economie"
  if (/(rekenen|wiskunde|breuk|procent|decimal|grafiek|getal)/.test(source)) return "Rekenen"
  if (/(nederlands|taal|spelling|grammatica|woordenschat|begrijpend lezen)/.test(source)) return "Nederlands"
  if (/(engels|english|vocabulary|grammar)/.test(source)) return "Engels"
  if (/(aardrijkskunde|geografie|landschap|kaart|werelddeel|klimaat)/.test(source)) return "Aardrijkskunde"
  if (/(geschiedenis|histor|romein|middeleeuw|oorlog|gouden eeuw)/.test(source)) return "Geschiedenis"
  if (/(biologie|lichaam|plant|dier|cel|natuur)/.test(source)) return "Biologie"
  if (/(islam|koran|moskee|ramadan|profeet)/.test(source)) return "Islamitische kennis"
  if (type === "practice") return "Oefentoets"
  if (type === "battle") return "Quiz"
  return "Algemeen"
}

function buildSessionTitle({ type, topic, lessonTitle }) {
  const cleanTopic = String(topic || "").trim() || "algemeen onderwerp"
  if (type === "lesson") return String(lessonTitle || `Les: ${cleanTopic}`).trim()
  if (type === "practice") return `Oefentoets: ${cleanTopic}`
  return `Quiz: ${cleanTopic}`
}

function normalizeSessionHistoryEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object") return null
  const type = ["lesson", "practice", "battle"].includes(String(rawEntry.type)) ? String(rawEntry.type) : "lesson"
  const topic = String(rawEntry.topic ?? "").trim()
  const lesson = rawEntry.lesson ? cloneLessonForRoom(rawEntry.lesson, rawEntry.lesson?.libraryId || null) : null
  const questions = cloneQuestionsForStorage(rawEntry.questions || [])

  return {
    id: String(rawEntry.id ?? generateEntityId("history")),
    type,
    category: String(rawEntry.category ?? detectSessionCategory(topic, type)).trim() || detectSessionCategory(topic, type),
    topic,
    title: String(rawEntry.title ?? buildSessionTitle({ type, topic, lessonTitle: lesson?.title })).trim() || buildSessionTitle({ type, topic, lessonTitle: lesson?.title }),
    audience: String(rawEntry.audience ?? lesson?.audience ?? "vmbo").trim() || "vmbo",
    model: String(rawEntry.model ?? lesson?.model ?? "battle").trim() || "battle",
    durationMinutes: Number(rawEntry.durationMinutes) || Number(lesson?.durationMinutes) || 0,
    lessonGoal: String(rawEntry.lessonGoal ?? lesson?.lessonGoal ?? "").trim(),
    questionCount: Number(rawEntry.questionCount) || questions.length || lesson?.practiceTest?.questions?.length || 0,
    phaseCount: Number(rawEntry.phaseCount) || lesson?.phases?.length || 0,
    practiceQuestionCount: Number(rawEntry.practiceQuestionCount) || lesson?.practiceTest?.questions?.length || 0,
    slideCount: Number(rawEntry.slideCount) || lesson?.presentation?.slides?.length || 0,
    providerLabel: String(rawEntry.providerLabel ?? "Lesson Battle").trim() || "Lesson Battle",
    source: String(rawEntry.source ?? type).trim() || type,
    questions,
    lesson,
    createdAt: String(rawEntry.createdAt ?? new Date().toISOString()),
    updatedAt: String(rawEntry.updatedAt ?? new Date().toISOString()),
  }
}

function loadSessionHistory() {
  try {
    ensureSharedDataDir()
    if (!fs.existsSync(sessionHistoryPath)) return []
    const parsed = JSON.parse(fs.readFileSync(sessionHistoryPath, "utf8"))
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalizeSessionHistoryEntry).filter(Boolean)
  } catch (error) {
    console.error("Kon sessiegeschiedenis niet laden:", error instanceof Error ? error.message : error)
    return []
  }
}

let sessionHistory = loadSessionHistory()

function persistSessionHistory() {
  try {
    ensureSharedDataDir()
    fs.writeFileSync(sessionHistoryPath, JSON.stringify(sessionHistory, null, 2), "utf8")
  } catch (error) {
    console.error("Kon sessiegeschiedenis niet opslaan:", error instanceof Error ? error.message : error)
    throw new Error("Opslaan van de sessiegeschiedenis is mislukt.")
  }
}

function sessionHistorySummaries() {
  return [...sessionHistory]
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .map((entry) => ({
      id: entry.id,
      type: entry.type,
      category: entry.category,
      topic: entry.topic,
      title: entry.title,
      audience: entry.audience,
      model: entry.model,
      durationMinutes: entry.durationMinutes,
      lessonGoal: entry.lessonGoal,
      questionCount: entry.questionCount,
      phaseCount: entry.phaseCount,
      practiceQuestionCount: entry.practiceQuestionCount,
      slideCount: entry.slideCount,
      providerLabel: entry.providerLabel,
      updatedAt: entry.updatedAt,
      createdAt: entry.createdAt,
    }))
}

function emitSessionHistoryToSocket(socket) {
  socket.emit("host:session-history:update", { entries: sessionHistorySummaries() })
}

function emitSessionHistoryToHosts() {
  for (const socketId of hostSocketIds) {
    io.to(socketId).emit("host:session-history:update", { entries: sessionHistorySummaries() })
  }
}

function recordSessionHistory(entryInput) {
  const entry = normalizeSessionHistoryEntry(entryInput)
  if (!entry) return
  try {
    sessionHistory = [entry, ...sessionHistory].slice(0, SESSION_HISTORY_LIMIT)
    persistSessionHistory()
    emitSessionHistoryToHosts()
  } catch (error) {
    console.error("Sessiegeschiedenis kon niet worden bijgewerkt:", error instanceof Error ? error.message : error)
  }
}

function buildSessionHistoryEntryFromRoom(room, type = "lesson") {
  const lesson = type === "lesson" ? cloneLessonForRoom(room.lesson, null) : null
  const now = new Date().toISOString()

  return {
    id: generateEntityId("history"),
    type,
    category: detectSessionCategory(room.game.topic, type),
    topic: room.game.topic,
    title: buildSessionTitle({
      type,
      topic: room.game.topic,
      lessonTitle: lesson?.title,
    }),
    audience: room.game.audience || lesson?.audience || "vmbo",
    model: lesson?.model || room.game.lessonModel || "battle",
    durationMinutes: lesson?.durationMinutes || room.game.lessonDurationMinutes || 0,
    lessonGoal: lesson?.lessonGoal || "",
    questionCount: type === "lesson" ? lesson?.practiceTest?.questions?.length || 0 : room.questions.length,
    phaseCount: lesson?.phases?.length || 0,
    practiceQuestionCount: lesson?.practiceTest?.questions?.length || 0,
    slideCount: lesson?.presentation?.slides?.length || 0,
    providerLabel: room.game.providerLabel || "Lesson Battle",
    source: room.game.source || type,
    questions: type === "lesson" ? [] : cloneQuestionsForStorage(room.questions),
    lesson,
    createdAt: now,
    updatedAt: now,
  }
}

function sanitizePersistedPlayer(rawPlayer) {
  return createPlayerRecord({
    id: rawPlayer?.id,
    learnerCode: rawPlayer?.learnerCode,
    name: rawPlayer?.name,
    teamId: rawPlayer?.teamId,
    classId: rawPlayer?.classId,
    className: rawPlayer?.className,
    classLearnerId: rawPlayer?.classLearnerId,
    score: rawPlayer?.score,
    connected: false,
  })
}

function serializeRoomSnapshot(room) {
  return {
    code: room.code,
    ownerUsername: room.ownerUsername || "",
    ownerDisplayName: room.ownerDisplayName || "",
    hostOnline: false,
    createdAt: room.createdAt || new Date().toISOString(),
    updatedAt: room.updatedAt || new Date().toISOString(),
    players: room.players.map((player) => ({
      id: player.id,
      learnerCode: player.learnerCode,
      name: player.name,
      teamId: player.teamId,
      classId: player.classId,
      className: player.className,
      classLearnerId: player.classLearnerId,
      score: player.score,
      connected: false,
    })),
    teams: room.teams.map((team) => ({ ...team })),
    questions: cloneQuestionsForStorage(room.questions),
    currentQuestionIndex: room.currentQuestionIndex,
    answeredPlayers: [...room.answeredPlayers],
    playerAnswers: [...room.playerAnswers.entries()],
    lessonResponses: [...room.lessonResponses.entries()],
    lesson: cloneLessonForRoom(room.lesson, room.lesson?.libraryId || null),
    math: serializeMathState(room.math),
    game: {
      ...room.game,
      questionStartedAt: room.game.questionStartedAt,
      generatedAt: room.game.generatedAt,
    },
  }
}

function deserializeRoomSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null
  const code = String(snapshot.code ?? "").trim().toUpperCase()
  if (!code) return null

  const room = {
    code,
    hostSocketId: null,
    ownerUsername: normalizeTeacherUsername(snapshot.ownerUsername),
    ownerDisplayName: String(snapshot.ownerDisplayName ?? snapshot.ownerUsername ?? "").trim(),
    hostOnline: false,
    createdAt: String(snapshot.createdAt ?? new Date().toISOString()),
    updatedAt: String(snapshot.updatedAt ?? new Date().toISOString()),
    players: Array.isArray(snapshot.players) ? snapshot.players.map(sanitizePersistedPlayer).filter(Boolean) : [],
    teams: Array.isArray(snapshot.teams)
      ? snapshot.teams.map((team, index) => ({
          id: String(team?.id ?? `team-${index + 1}`),
          name: String(team?.name ?? `Team ${index + 1}`),
          color: String(team?.color ?? TEAM_COLORS[index % TEAM_COLORS.length]),
          score: Number(team?.score) || 0,
        }))
      : createTeams(),
    questions: cloneQuestionsForStorage(snapshot.questions),
    currentQuestionIndex: Number.isInteger(snapshot.currentQuestionIndex) ? snapshot.currentQuestionIndex : -1,
    answeredPlayers: new Set(Array.isArray(snapshot.answeredPlayers) ? snapshot.answeredPlayers.map((value) => String(value)) : []),
    playerAnswers: new Map(
      Array.isArray(snapshot.playerAnswers)
        ? snapshot.playerAnswers.map(([playerId, answer]) => [
            String(playerId),
            {
              answerIndex: Number(answer?.answerIndex),
              isCorrect: Boolean(answer?.isCorrect),
              elapsedMs: Number(answer?.elapsedMs) || 0,
              awardedPoints: Number(answer?.awardedPoints) || 0,
              basePoints: Number(answer?.basePoints) || 0,
              speedBonus: Number(answer?.speedBonus) || 0,
              multiplier: Math.max(1, Number(answer?.multiplier) || 1),
            },
          ])
        : []
    ),
    lessonResponses: new Map(
      Array.isArray(snapshot.lessonResponses)
        ? snapshot.lessonResponses.map(([playerId, response]) => [
            String(playerId),
            {
              text: String(response?.text ?? ""),
              isCorrect: Boolean(response?.isCorrect),
              label: String(response?.label ?? ""),
              feedback: String(response?.feedback ?? ""),
              submittedAt: String(response?.submittedAt ?? ""),
            },
          ])
        : []
    ),
    lesson: cloneLessonForRoom(snapshot.lesson || createEmptyLessonState(), snapshot.lesson?.libraryId || null),
    math: deserializeMathState(snapshot.math),
    closingTimeout: null,
    game: {
      ...createIdleGameState(),
      ...(snapshot.game || {}),
      questionStartedAt: snapshot.game?.questionStartedAt || null,
      generatedAt: snapshot.game?.generatedAt || null,
    },
  }

  reassignPlayersToExistingTeams(room)
  syncTeamScores(room)
  return room
}

function canPersistMathRoomToCloud(room) {
  return Boolean(mathCloudEnabled && room?.game?.mode === "math" && room?.math?.selectedBand)
}

function buildMathCloudRoomDocument(room) {
  return {
    fields: {
      roomCode: firestoreStringField(room.code),
      title: firestoreStringField(room.math?.title || ""),
      selectedBand: firestoreStringField(normalizeMathLevel(room.math?.selectedBand || "")),
      updatedAt: firestoreStringField(room.updatedAt || new Date().toISOString()),
      createdAt: firestoreStringField(room.createdAt || new Date().toISOString()),
      snapshotJson: firestoreStringField(JSON.stringify(serializeRoomSnapshot(room))),
      source: firestoreStringField("lesson-battle"),
      active: firestoreBooleanField(true),
    },
  }
}

function buildMathCloudResumeDocument(room, player) {
  return {
    fields: {
      roomCode: firestoreStringField(room.code),
      playerId: firestoreStringField(player.id),
      learnerCode: firestoreStringField(player.learnerCode || ""),
      name: firestoreStringField(player.name || ""),
      nameKey: firestoreStringField(normalizeParticipantName(player.name || "")),
      updatedAt: firestoreStringField(room.updatedAt || new Date().toISOString()),
      active: firestoreBooleanField(true),
    },
  }
}

async function writeMathRoomToCloud(room) {
  if (!canPersistMathRoomToCloud(room)) return
  await firestoreRequest(firestoreDocUrl(MATH_CLOUD_COLLECTION, room.code), {
    method: "PATCH",
    body: buildMathCloudRoomDocument(room),
  })
}

function schedulePersistMathRoomToCloud(room) {
  if (!canPersistMathRoomToCloud(room)) return
  const roomCode = room.code
  if (mathCloudPersistTimers.has(roomCode)) return
  const timer = setTimeout(async () => {
    mathCloudPersistTimers.delete(roomCode)
    const latestRoom = rooms.get(roomCode) || room
    if (!canPersistMathRoomToCloud(latestRoom)) return
    try {
      await writeMathRoomToCloud(latestRoom)
    } catch (error) {
      console.error("Kon rekenroom niet naar Firestore schrijven:", error instanceof Error ? error.message : error)
    }
  }, MATH_CLOUD_PERSIST_DEBOUNCE_MS)
  mathCloudPersistTimers.set(roomCode, timer)
}

async function syncMathResumeIndexForPlayer(room, player) {
  if (!canPersistMathRoomToCloud(room)) return
  if (!player?.id || !player?.name || !isValidLearnerCode(player?.learnerCode)) return
  try {
    await firestoreRequest(firestoreDocUrl(MATH_CLOUD_RESUME_COLLECTION, buildMathCloudResumeDocId(player.name, player.learnerCode)), {
      method: "PATCH",
      body: buildMathCloudResumeDocument(room, player),
    })
  } catch (error) {
    console.error("Kon resume-index niet opslaan:", error instanceof Error ? error.message : error)
  }
}

async function syncMathResumeIndexForRoom(room) {
  if (!canPersistMathRoomToCloud(room)) return
  await Promise.all(room.players.map((player) => syncMathResumeIndexForPlayer(room, player)))
}

async function removeMathResumeIndex(name, learnerCode) {
  if (!mathCloudEnabled || !name || !isValidLearnerCode(learnerCode)) return
  try {
    await firestoreRequest(firestoreDocUrl(MATH_CLOUD_RESUME_COLLECTION, buildMathCloudResumeDocId(name, learnerCode)), {
      method: "DELETE",
    })
  } catch (error) {
    if (!String(error instanceof Error ? error.message : error).includes("404")) {
      console.error("Kon oude resume-index niet verwijderen:", error instanceof Error ? error.message : error)
    }
  }
}

async function loadMathRoomFromCloud(roomCode) {
  if (!mathCloudEnabled) return null
  const normalizedCode = String(roomCode ?? "").trim().toUpperCase()
  if (!normalizedCode) return null
  try {
    const document = await firestoreRequest(firestoreDocUrl(MATH_CLOUD_COLLECTION, normalizedCode))
    const snapshotJson = readFirestoreString(document, "snapshotJson", "")
    if (!snapshotJson) return null
    const snapshot = JSON.parse(snapshotJson)
    const restoredRoom = deserializeRoomSnapshot(snapshot)
    if (!restoredRoom || restoredRoom.game?.mode !== "math" || !restoredRoom.math?.selectedBand) return null
    return restoredRoom
  } catch (error) {
    console.error("Kon rekenroom niet uit Firestore laden:", error instanceof Error ? error.message : error)
    return null
  }
}

async function restoreMathRoomFromCloud(roomCode, { allowAlternateCode = false } = {}) {
  const normalizedCode = String(roomCode ?? "").trim().toUpperCase()
  if (!normalizedCode) return null
  if (rooms.has(normalizedCode)) return rooms.get(normalizedCode) || null

  const restoredRoom = await loadMathRoomFromCloud(normalizedCode)
  if (!restoredRoom) return null
  if (rooms.has(restoredRoom.code)) {
    if (!allowAlternateCode) return null
    restoredRoom.code = generateRoomCode()
  }

  for (const player of restoredRoom.players) {
    player.socketId = null
    player.connected = false
  }
  restoredRoom.hostSocketId = null
  restoredRoom.hostOnline = false
  rooms.set(restoredRoom.code, restoredRoom)
  await Promise.all(
    restoredRoom.players.map((player) => ensureMathGrowthRecordLoaded(player.name || "", player.learnerCode || ""))
  )
  scheduleRoomClosure(restoredRoom)
  emitStateToRoom(restoredRoom)
  return restoredRoom
}

async function findMathRoomForHomeResumeFromCloud(name, learnerCode) {
  if (!mathCloudEnabled) return { room: null, player: null }
  if (!name || !isValidLearnerCode(learnerCode)) return { room: null, player: null }

  try {
    const document = await firestoreRequest(
      firestoreDocUrl(MATH_CLOUD_RESUME_COLLECTION, buildMathCloudResumeDocId(name, learnerCode))
    )
    if (!document) return { room: null, player: null }

    const roomCode = readFirestoreString(document, "roomCode", "")
    const playerId = readFirestoreString(document, "playerId", "")
    let room = roomCode ? rooms.get(roomCode) || null : null
    if (!room && roomCode) {
      room = await restoreMathRoomFromCloud(roomCode, { allowAlternateCode: true })
    }
    if (!room || room.game?.mode !== "math") return { room: null, player: null }

    const normalizedName = normalizeParticipantName(name)
    const player =
      room.players.find((entry) => entry.id === playerId) ||
      room.players.find(
        (entry) =>
          entry.learnerCode === normalizeLearnerCode(learnerCode) && normalizeParticipantName(entry.name || "") === normalizedName
      ) ||
      null

    return { room, player }
  } catch (error) {
    console.error("Kon thuisroute niet uit Firestore laden:", error instanceof Error ? error.message : error)
    return { room: null, player: null }
  }
}

function loadPersistedRooms() {
  try {
    ensureSharedDataDir()
    if (!fs.existsSync(activeRoomsPath)) return []
    const parsed = JSON.parse(fs.readFileSync(activeRoomsPath, "utf8"))
    if (!Array.isArray(parsed)) return []
    return parsed.map(deserializeRoomSnapshot).filter(Boolean)
  } catch (error) {
    console.error("Kon actieve rooms niet laden:", error instanceof Error ? error.message : error)
    return []
  }
}

function persistActiveRooms() {
  try {
    ensureSharedDataDir()
    const snapshots = [...rooms.values()].map(serializeRoomSnapshot)
    fs.writeFileSync(activeRoomsPath, JSON.stringify(snapshots, null, 2), "utf8")
  } catch (error) {
    console.error("Kon actieve rooms niet opslaan:", error instanceof Error ? error.message : error)
  }
}

function schedulePersistActiveRooms() {
  if (roomPersistenceTimer) return
  roomPersistenceTimer = setTimeout(() => {
    roomPersistenceTimer = null
    persistActiveRooms()
  }, 25)
}

function restoreRoomsFromDisk() {
  const restoredRooms = loadPersistedRooms()
  for (const room of restoredRooms) {
    rooms.set(room.code, room)
    scheduleRoomClosure(room)
  }
}

function buildHostInsights(room) {
  const onlinePlayers = getOnlinePlayers(room)
  const unansweredPlayers = room.players
    .filter((player) =>
      room.game.mode === "lesson" ? !room.lessonResponses.has(player.id) : !room.playerAnswers.has(player.id)
    )
    .map((player) => ({
      playerId: player.id,
      name: player.name,
      teamId: player.teamId,
      teamName: room.teams.find((team) => team.id === player.teamId)?.name || "",
      connected: player.connected !== false,
    }))

  if (room.game.mode === "math") {
    return {
      mode: "math",
      selectedBand: formatMathLevel(room.math?.selectedBand || MATH_LEVELS[1]),
      intakeTotal: room.math?.intakeQuestions?.length || 0,
      players: room.players.map((player) => {
        const progress = room.math?.playerProgress?.get(player.id) || ensureMathProgress(room, player.id)
        return {
          playerId: player.id,
          learnerCode: player.learnerCode || "",
          name: player.name,
          teamId: player.teamId,
          teamName: room.teams.find((team) => team.id === player.teamId)?.name || "",
          connected: player.connected !== false,
          phase: progress?.phase || "intake",
          placementLevel: progress?.placementLevel ? formatMathLevel(progress.placementLevel) : "",
          targetLevel: progress?.targetLevel ? formatMathLevel(progress.targetLevel) : "",
          practiceDifficulty: clampMathDifficulty(progress?.practiceDifficulty || 2),
          answeredCount: getMathAnsweredCount(progress),
          correctCount: getMathCorrectCount(progress),
          wrongCount: getMathWrongCount(progress),
          accuracyRate: getMathAccuracyRate(progress),
          focusDomains: getMathFocusDomains(progress),
          workLabel: getMathWorkLabel(progress),
          practiceQuestionCount: Number(progress?.practiceQuestionCount) || 0,
          practiceCorrectCount: Number(progress?.practiceCorrectCount) || 0,
          awaitingNext: Boolean(progress?.awaitingNext),
          currentTaskPrompt: progress?.currentTask?.prompt || "",
          answerHistory: Array.isArray(progress?.answerHistory)
            ? progress.answerHistory.map((entry) => ({
                ...entry,
                level: entry?.level ? formatMathLevel(entry.level) : "",
              }))
            : [],
          lastAnsweredAt: progress?.lastAnsweredAt || null,
        }
      }),
    }
  }

  if (room.game.mode === "lesson") {
    const phase = currentLessonPhase(room)
    if (!phase) return null
    const answeredCount = room.lessonResponses.size
    const totalPlayers = onlinePlayers.length
    const allAnswered = totalPlayers > 0 && answeredCount >= totalPlayers

    return {
      mode: "lesson",
      phaseId: phase.id,
      phaseTitle: phase.title,
      prompt: getActiveLessonPrompt(room.lesson),
      answeredCount,
      totalPlayers,
      allAnswered,
      canAdvance: allAnswered,
      expectedAnswer: getActiveLessonExpectedAnswer(room.lesson),
      unansweredPlayers,
      responses: room.players.map((player) => {
        const response = room.lessonResponses.get(player.id)
        return {
          playerId: player.id,
          name: player.name,
          teamId: player.teamId,
          teamName: room.teams.find((team) => team.id === player.teamId)?.name || "",
          connected: player.connected !== false,
          answered: Boolean(response),
          answerText: response?.text || "",
          isCorrect: response?.isCorrect ?? null,
          evaluationLabel: response?.label || null,
          feedback: response?.feedback || "",
        }
      }),
    }
  }

  const question = currentQuestion(room)
  if (!question) return null
  const answeredCount = room.answeredPlayers.size
  const totalPlayers = onlinePlayers.length
  const allAnswered = totalPlayers > 0 && answeredCount >= totalPlayers
  const answerWindowExpired = hasBattleAnswerWindowExpired(room, question)
  const race = getTeamRaceSnapshot(room)
  const distribution = (question.options || []).map((option, index) => {
    const playersForOption = room.players.filter((player) => room.playerAnswers.get(player.id)?.answerIndex === index)
    return {
      index,
      key: String.fromCharCode(65 + index),
      option,
      count: playersForOption.length,
      players: playersForOption.map((player) => ({
        playerId: player.id,
        name: player.name,
        teamId: player.teamId,
        teamName: room.teams.find((team) => team.id === player.teamId)?.name || "",
        connected: player.connected !== false,
      })),
    }
  })

  return {
    mode: "battle",
    questionId: question?.id ?? null,
    answeredCount,
    totalPlayers,
    allAnswered,
    answerWindowExpired,
    canRevealAnswer: canRevealBattleAnswer(room, question),
    canAdvance: Boolean(question) && (allAnswered || room.game.status === "revealed"),
    correctIndex: question ? question.correctIndex : null,
    correctOption: question ? question.options[question.correctIndex] : null,
    explanation: question ? question.explanation : "",
    questionMultiplier: Math.max(1, Number(room.game.questionMultiplier) || 1),
    finalSprintActive: Boolean(room.game.finalSprintActive),
    leadingTeamName: room.game.leadingTeamName || race.leader?.name || "",
    leadingGap: Number(room.game.leadingGap) || race.gap || 0,
    unansweredPlayers,
    distribution,
    responses: room.players.map((player) => {
      const answer = room.playerAnswers.get(player.id)

      return {
        playerId: player.id,
        name: player.name,
        teamId: player.teamId,
        teamName: room.teams.find((team) => team.id === player.teamId)?.name || "",
        connected: player.connected !== false,
        answered: Boolean(answer),
        answerIndex: answer?.answerIndex ?? null,
        answerText: answer ? question?.options?.[answer.answerIndex] ?? null : null,
        isCorrect: answer ? answer.isCorrect : null,
        awardedPoints: Number(answer?.awardedPoints) || 0,
        basePoints: Number(answer?.basePoints) || 0,
        speedBonus: Number(answer?.speedBonus) || 0,
        multiplier: Math.max(1, Number(answer?.multiplier) || 1),
        elapsedMs: Number(answer?.elapsedMs) || 0,
      }
    }),
  }
}

function emitHostInsights(room) {
  if (!room?.hostSocketId) return
  io.to(room.hostSocketId).emit("host:question:insights", buildHostInsights(room))
}

function emitRoomBackupToHost(room) {
  if (!room?.hostSocketId) return
  io.to(room.hostSocketId).emit("host:room:backup", {
    snapshot: serializeRoomSnapshot(room),
  })
}

function emitLessonPromptUpdate(room) {
  if (room.game.mode !== "lesson") return
  const promptVersion = room.lesson?.promptVersion ?? Date.now()

  if (room.hostSocketId) {
    io.to(room.hostSocketId).emit("lesson:prompt:update", {
      lesson: sanitizeLesson(room.lesson, "host"),
      currentPhaseIndex: room.lesson?.currentPhaseIndex ?? -1,
      promptVersion,
    })
  }

  const lessonForPlayer = sanitizeLesson(room.lesson, "player")
  for (const player of getOnlinePlayers(room)) {
    io.to(player.socketId).emit("lesson:prompt:update", {
      lesson: lessonForPlayer,
      currentPhaseIndex: room.lesson?.currentPhaseIndex ?? -1,
      promptVersion,
    })
  }
}

function emitStateToRoom(room) {
  markRoomUpdated(room)
  const hostPayload = buildStatePayload(room, "host")

  if (room.hostSocketId) {
    io.to(room.hostSocketId).emit("players:update", hostPayload.players)
    io.to(room.hostSocketId).emit("teams:update", hostPayload.teams)
    io.to(room.hostSocketId).emit("leaderboard:update", hostPayload.leaderboard)
    io.to(room.hostSocketId).emit("game:update", hostPayload.game)
    emitRoomBackupToHost(room)
  }

  for (const player of getOnlinePlayers(room)) {
    const playerPayload = buildStatePayload(room, "player", player.id)
    io.to(player.socketId).emit("players:update", playerPayload.players)
    io.to(player.socketId).emit("teams:update", playerPayload.teams)
    io.to(player.socketId).emit("leaderboard:update", playerPayload.leaderboard)
    io.to(player.socketId).emit("game:update", playerPayload.game)
  }
  emitHostInsights(room)
  schedulePersistActiveRooms()
  schedulePersistMathRoomToCloud(room)
}

function emitStateToSocket(socket, room) {
  const payload = room
    ? buildStatePayload(
        room,
        hostSocketIds.has(socket.id) ? "host" : "player",
        hostSocketIds.has(socket.id) ? "" : getPlayerBySocketId(room, socket.id)?.id || ""
      )
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
          answerRevealed: false,
          source: "idle",
          providerLabel: null,
          generatedAt: null,
          mode: "battle",
          lessonModel: "edi",
          lessonDurationMinutes: 45,
          currentQuestionIndex: -1,
          totalQuestions: 0,
          currentPhaseIndex: -1,
          totalPhases: 0,
          roomCodeActive: false,
          question: null,
          lesson: null,
          math: null,
        },
      }
  socket.emit("state:init", payload)
  if (room && hostSocketIds.has(socket.id)) {
    socket.emit("host:room:backup", {
      snapshot: serializeRoomSnapshot(room),
    })
  }
}

async function updatePresentationSlideManualImage({ room, slideId, imageUrl, imageAlt, uploadDataUrl }) {
  if (!room || room.game.mode !== "lesson" || !room.lesson?.presentation?.slides?.length) {
    throw new Error("Er staat nu geen actieve presentatie klaar.")
  }

  const normalizedSlideId = String(slideId ?? "").trim()
  if (!normalizedSlideId) {
    throw new Error("Kies eerst een dia voordat je een afbeelding instelt.")
  }

  const previousSlide = room.lesson.presentation.slides.find((slide) => slide.id === normalizedSlideId) || null
  if (!previousSlide) {
    throw new Error("Deze dia bestaat niet meer in de huidige presentatie.")
  }

  const previousManualImageUrl = sanitizeManualImageUrl(previousSlide.manualImageUrl || "")
  let nextManualImageUrl = sanitizeManualImageUrl(imageUrl)
  if (String(uploadDataUrl || "").trim()) {
    nextManualImageUrl = saveManualImageFromDataUrl({
      dataUrl: uploadDataUrl,
      entityId: normalizedSlideId,
    })
  } else if (nextManualImageUrl && !isLocalManualImageUrl(nextManualImageUrl)) {
    nextManualImageUrl = await saveManualImageFromRemoteUrl({
      imageUrl: nextManualImageUrl,
      entityId: normalizedSlideId,
    })
  }

  if (!nextManualImageUrl) {
    throw new Error("Plak een geldige afbeeldingslink of upload een bestand.")
  }

  const nextImageAlt = String(imageAlt ?? "").trim() || previousSlide.imageAlt || previousSlide.title || "Presentatiedia"
  room.lesson = {
    ...room.lesson,
    presentation: {
      ...room.lesson.presentation,
      slides: room.lesson.presentation.slides.map((slide) =>
        slide.id === normalizedSlideId
          ? {
              ...slide,
              manualImageUrl: nextManualImageUrl,
              imageAlt: nextImageAlt,
              manualImageSourceUrl: "",
              manualImageSourceImageUrl: "",
              manualImageSearchQuery: "",
              manualImageSourceTitle: "",
              manualImageSourceHistory: sanitizeImageSourceHistory(slide.manualImageSourceHistory || []),
            }
          : slide
      ),
    },
  }

  if (previousManualImageUrl && previousManualImageUrl !== nextManualImageUrl) {
    removeManualImageFileIfUnused(previousManualImageUrl)
  }

  emitStateToRoom(room)
  return {
    slideId: normalizedSlideId,
    manualImageUrl: nextManualImageUrl,
    imageAlt: nextImageAlt,
  }
}

async function updateCurrentQuestionManualImage({ room, imageUrl, imageAlt, uploadDataUrl }) {
  const activeQuestion = currentQuestion(room)
  if (!room || !activeQuestion) {
    throw new Error("Er staat nu geen actieve vraag klaar.")
  }

  const previousManualImageUrl = sanitizeManualImageUrl(activeQuestion.manualImageUrl || "")
  let nextManualImageUrl = sanitizeManualImageUrl(imageUrl)
  if (String(uploadDataUrl || "").trim()) {
    nextManualImageUrl = saveManualImageFromDataUrl({
      dataUrl: uploadDataUrl,
      entityId: activeQuestion.id || `question-${room.currentQuestionIndex + 1}`,
    })
  } else if (nextManualImageUrl && !isLocalManualImageUrl(nextManualImageUrl)) {
    nextManualImageUrl = await saveManualImageFromRemoteUrl({
      imageUrl: nextManualImageUrl,
      entityId: activeQuestion.id || `question-${room.currentQuestionIndex + 1}`,
    })
  }

  if (!nextManualImageUrl) {
    throw new Error("Plak een geldige afbeeldingslink of upload een bestand.")
  }

  const nextImageAlt =
    String(imageAlt ?? "").trim() ||
    activeQuestion.imageAlt ||
    String(activeQuestion.prompt || activeQuestion.question_text || "").trim() ||
    "Vraagafbeelding"

  room.questions = room.questions.map((question, index) =>
    index === room.currentQuestionIndex
      ? {
          ...question,
          manualImageUrl: nextManualImageUrl,
          imageAlt: nextImageAlt,
          manualImageSourceUrl: "",
          manualImageSourceImageUrl: "",
          manualImageSearchQuery: "",
          manualImageSourceTitle: "",
          manualImageSearchAttempt: Math.max(0, Number(question?.manualImageSearchAttempt) || 0),
          manualImageSourceHistory: sanitizeImageSourceHistory(question?.manualImageSourceHistory || []),
        }
      : question
  )

  if (previousManualImageUrl && previousManualImageUrl !== nextManualImageUrl) {
    removeManualImageFileIfUnused(previousManualImageUrl)
  }

  emitStateToRoom(room)
  return {
    questionId: activeQuestion.id,
    manualImageUrl: nextManualImageUrl,
    imageAlt: nextImageAlt,
  }
}

function stampQuestionStart(room) {
  applyQuestionScoringProfile(room, room.currentQuestionIndex)
  room.game = {
    ...room.game,
    questionStartedAt: new Date().toISOString(),
    status: "live",
    answerRevealed: false,
  }
}

function setCurrentQuestionPreview(room, questionIndex) {
  const nextQuestion = room.questions[questionIndex] ?? null
  room.currentQuestionIndex = nextQuestion ? questionIndex : -1
  room.answeredPlayers = new Set()
  room.playerAnswers = new Map()
  const scoringProfile = nextQuestion ? applyQuestionScoringProfile(room, questionIndex) : null
  room.game = {
    ...room.game,
    questionStartedAt: null,
    questionDurationSec: Number(nextQuestion?.durationSec) || room.game.questionDurationSec || 20,
    status: nextQuestion ? "preview" : room.questions.length ? "finished" : "idle",
    answerRevealed: false,
    mode: "battle",
    questionMultiplier: scoringProfile?.multiplier ?? 1,
    finalSprintActive: Boolean(scoringProfile?.finalSprintActive),
    leadingTeamId: scoringProfile?.leader?.id ?? null,
    leadingTeamName: scoringProfile?.leader?.name ?? "",
    leadingTeamScore: scoringProfile?.leader?.score ?? 0,
    runnerUpTeamId: scoringProfile?.runnerUp?.id ?? null,
    runnerUpTeamName: scoringProfile?.runnerUp?.name ?? "",
    runnerUpTeamScore: scoringProfile?.runnerUp?.score ?? 0,
    leadingGap: scoringProfile?.gap ?? 0,
  }
}

function clearRoomClosingTimeout(room) {
  if (!room?.closingTimeout) return
  clearTimeout(room.closingTimeout)
  room.closingTimeout = null
}

function scheduleRoomClosure(room) {
  clearRoomClosingTimeout(room)
  room.hostOnline = false
  room.hostSocketId = null
  const graceMs = room?.game?.mode === "math" ? MATH_ROOM_GRACE_MS : ROOM_HOST_GRACE_MS
  room.closingTimeout = setTimeout(() => {
    for (const player of room.players) {
      if (player.socketId) {
        socketToRoom.delete(player.socketId)
        io.to(player.socketId).emit("player:removed", { message: "Deze room is gesloten door de docent." })
      }
    }
    rooms.delete(room.code)
    schedulePersistActiveRooms()
  }, graceMs)
  schedulePersistActiveRooms()
}

function claimRoomForHost(room, socketId) {
  clearRoomClosingTimeout(room)
  hostSocketIds.add(socketId)
  socketToRoom.set(socketId, room.code)
  room.hostSocketId = socketId
  room.hostOnline = true
  markRoomUpdated(room)
  schedulePersistActiveRooms()
}

function extractJsonArray(text) {
  const cleaned = text.replace(/```json|```/gi, "").trim()
  const start = cleaned.indexOf("[")
  const end = cleaned.lastIndexOf("]")
  if (start === -1 || end === -1 || end <= start) throw new Error("AI antwoord bevat geen geldige JSON-array.")
  return cleaned.slice(start, end + 1)
}

function extractJsonObject(text) {
  const cleaned = text.replace(/```json|```/gi, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) throw new Error("AI antwoord bevat geen geldig JSON-object.")
  return cleaned.slice(start, end + 1)
}

function normalizePracticeQuestionFormat(value = "") {
  const normalized = String(value || "").trim().toLowerCase()
  if (["typed", "flashcards", "flashcard", "type", "invul", "invoer"].includes(normalized)) return "typed"
  if (["mixed", "gemengd", "mix"].includes(normalized)) return "mixed"
  return "multiple-choice"
}

function normalizeAcceptedAnswers(question = {}) {
  const rawAcceptedAnswers = Array.isArray(question?.acceptedAnswers)
    ? question.acceptedAnswers
    : [question?.correctAnswer, question?.answer, question?.displayAnswer]

  return [...new Set(
    rawAcceptedAnswers
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
  )]
}

function convertMultipleChoiceQuestionToTyped(question) {
  const correctAnswer =
    String(question?.displayAnswer || question?.options?.[question?.correctIndex] || question?.acceptedAnswers?.[0] || "").trim()
  const acceptedAnswers = [...new Set([correctAnswer, ...normalizeAcceptedAnswers(question)])].filter(Boolean)

  return {
    ...question,
    questionType: "typed",
    options: [],
    correctIndex: null,
    acceptedAnswers,
    displayAnswer: correctAnswer || acceptedAnswers[0] || "",
    answerPlaceholder: String(question?.answerPlaceholder || "Typ hier je antwoord").trim() || "Typ hier je antwoord",
  }
}

function applyRequestedQuestionFormat(questionList, questionFormat = "multiple-choice") {
  const requestedFormat = normalizePracticeQuestionFormat(questionFormat)
  const preparedQuestions = (questionList || []).map((question) => ({ ...question }))

  if (requestedFormat === "typed") {
    return preparedQuestions.map((question) =>
      question.questionType === "typed" ? question : convertMultipleChoiceQuestionToTyped(question)
    )
  }

  if (requestedFormat === "mixed") {
    return preparedQuestions.map((question, index) => {
      if (question.questionType === "typed") return question
      return index % 2 === 1 ? convertMultipleChoiceQuestionToTyped(question) : question
    })
  }

  return preparedQuestions
}

function normalizeQuestions(rawQuestions, { questionFormat = "multiple-choice" } = {}) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) throw new Error("AI gaf geen bruikbare vragen terug.")
  const requestedFormat = normalizePracticeQuestionFormat(questionFormat)
  const normalizedQuestions = rawQuestions
    .map((question, index) => {
      const prompt = String(question?.prompt ?? "").trim()
      const explanation = String(question?.explanation ?? "").trim()
      const category = String(question?.category ?? "").trim() || "Quiz"
      const imagePrompt = ensureQuestionImagePrompt(question?.prompt, question?.category, question?.imagePrompt)
      const imageAlt = String(question?.imageAlt ?? "").trim()
      const rawOptions = Array.isArray(question?.options)
        ? question.options.map((option) => String(option).trim()).slice(0, 4)
        : []
      const rawCorrectIndex = Number(question?.correctIndex)
      const explicitType = normalizePracticeQuestionFormat(question?.questionType || question?.format || "")
      const inferredTyped = normalizeAcceptedAnswers(question).length > 0 && rawOptions.length < 4
      const questionType = explicitType !== "multiple-choice" ? explicitType : inferredTyped ? "typed" : requestedFormat === "typed" ? "typed" : "multiple-choice"

      if (!prompt) return null

      if (questionType === "typed") {
        const acceptedAnswers = [...new Set([
          ...normalizeAcceptedAnswers(question),
          rawOptions.length === 4 && Number.isInteger(rawCorrectIndex) && rawCorrectIndex >= 0 && rawCorrectIndex < 4
            ? rawOptions[rawCorrectIndex]
            : "",
        ])].filter(Boolean)
        const displayAnswer =
          String(question?.displayAnswer ?? question?.correctAnswer ?? question?.answer ?? acceptedAnswers[0] ?? "").trim()

        if (!acceptedAnswers.length && !displayAnswer) return null

        return {
          id: `q-${index + 1}`,
          prompt,
          options: [],
          correctIndex: null,
          questionType: "typed",
          acceptedAnswers: acceptedAnswers.length ? acceptedAnswers : [displayAnswer],
          displayAnswer: displayAnswer || acceptedAnswers[0] || "",
          answerPlaceholder: String(question?.answerPlaceholder ?? "Typ hier je antwoord").trim() || "Typ hier je antwoord",
          explanation,
          category,
          imagePrompt,
          imageAlt,
        }
      }

      if (
        !(
          rawOptions.length === 4 &&
          rawOptions.every(Boolean) &&
          Number.isInteger(rawCorrectIndex) &&
          rawCorrectIndex >= 0 &&
          rawCorrectIndex < 4
        )
      ) {
        return null
      }

      return {
        id: `q-${index + 1}`,
        prompt,
        options: rawOptions,
        correctIndex: rawCorrectIndex,
        questionType: "multiple-choice",
        acceptedAnswers: [],
        displayAnswer: String(rawOptions[rawCorrectIndex] || "").trim(),
        answerPlaceholder: "",
        explanation,
        category,
        imagePrompt,
        imageAlt,
      }
    })
    .filter(Boolean)

  return applyRequestedQuestionFormat(normalizedQuestions, requestedFormat)
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
  const multipleChoiceQuestions = questionList.filter((question) => question?.questionType !== "typed")
  if (!multipleChoiceQuestions.length) return questionList
  const targetCounts = questionList.reduce((counts, _, index) => {
    counts[index % 4] += 1
    return counts
  }, [0, 0, 0, 0])

  const usageCounts = [0, 0, 0, 0]
  const chosenSequence = []

  const rebalancedMultipleChoiceQuestions = multipleChoiceQuestions.map((question) => {
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

  let multipleChoiceIndex = 0
  return questionList.map((question) => {
    if (question?.questionType === "typed") return question
    const nextQuestion = rebalancedMultipleChoiceQuestions[multipleChoiceIndex]
    multipleChoiceIndex += 1
    return nextQuestion || question
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

function buildFallbackQuestions({ topic, questionCount, questionFormat = "multiple-choice" }) {
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

  return applyRequestedQuestionFormat(rebalanceQuestions(questions), questionFormat)
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

function getFileExtension(fileName = "") {
  const normalized = String(fileName || "").trim().toLowerCase()
  const index = normalized.lastIndexOf(".")
  return index >= 0 ? normalized.slice(index) : ""
}

function normalizeAiPromptAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return []
  return attachments
    .slice(0, MAX_AI_ATTACHMENT_COUNT)
    .map((attachment, index) => ({
      id: String(attachment?.id || `attachment-${index + 1}`).trim(),
      name: String(attachment?.name || `bijlage-${index + 1}`).trim() || `bijlage-${index + 1}`,
      mimeType: String(attachment?.mimeType || "application/octet-stream").trim().toLowerCase(),
      size: Math.max(0, Number(attachment?.size) || 0),
      fileDataBase64: String(attachment?.fileDataBase64 || "").trim(),
    }))
    .filter((attachment) => attachment.fileDataBase64)
}

function sanitizeAttachmentText(value = "") {
  return String(value || "")
    .replace(/\u0000/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function extractWorksheetPreviewText(workbook) {
  const sheetNames = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames.slice(0, 3) : []
  const sections = []

  for (const sheetName of sheetNames) {
    const worksheet = workbook?.Sheets?.[sheetName]
    if (!worksheet) continue
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "" }).slice(0, 18)
    const rowText = rows
      .map((row) =>
        (Array.isArray(row) ? row : [])
          .map((cell) => String(cell ?? "").trim())
          .filter(Boolean)
          .join(" | ")
      )
      .filter(Boolean)
      .join("\n")
    if (rowText) {
      sections.push(`Sheet: ${sheetName}\n${rowText}`)
    }
  }

  return sections.join("\n\n")
}

async function extractTextFromAiPromptAttachment(attachment) {
  const extension = getFileExtension(attachment?.name)
  const mimeType = String(attachment?.mimeType || "").toLowerCase()
  const buffer = Buffer.from(String(attachment?.fileDataBase64 || ""), "base64")

  if (!buffer.length) throw new Error("De bijlage is leeg.")
  if (buffer.length > MAX_AI_ATTACHMENT_FILE_BYTES) {
    throw new Error(`${attachment?.name || "Een bijlage"} is te groot.`)
  }

  if (SUPPORTED_AI_ATTACHMENT_EXTENSIONS.has(extension) === false && !mimeType.startsWith("text/")) {
    throw new Error(`${attachment?.name || "Deze bijlage"} wordt nog niet ondersteund.`)
  }

  if (extension === ".pdf" || mimeType === "application/pdf") {
    const pdfParseModule = await import("pdf-parse")
    const PDFParse = pdfParseModule.PDFParse || pdfParseModule.default?.PDFParse
    if (typeof PDFParse !== "function") {
      throw new Error("De PDF-lezer kon niet worden gestart.")
    }
    const parser = new PDFParse({ data: buffer })
    try {
      const parsed = await parser.getText()
      const extractedText = sanitizeAttachmentText(parsed?.text || "")
      if (!extractedText) {
        throw new Error("Deze PDF bevat geen leesbare tekstlaag. Gebruik een doorzoekbare PDF of een Word-/TXT-bestand.")
      }
      return extractedText
    } finally {
      if (typeof parser.destroy === "function") {
        await parser.destroy().catch(() => {})
      }
    }
  }

  if (extension === ".docx" || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammothModule = await import("mammoth")
    const extractRawText = mammothModule.extractRawText || mammothModule.default?.extractRawText
    if (typeof extractRawText !== "function") {
      throw new Error("De Word-lezer kon niet worden gestart.")
    }
    const extracted = await extractRawText({ buffer })
    const extractedText = sanitizeAttachmentText(extracted?.value || "")
    if (!extractedText) {
      throw new Error("Dit Word-bestand bevat geen leesbare tekst.")
    }
    return extractedText
  }

  if (
    extension === ".xlsx" ||
    extension === ".xls" ||
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-excel"
  ) {
    const workbook = XLSX.read(buffer, { type: "buffer" })
    const extractedText = sanitizeAttachmentText(extractWorksheetPreviewText(workbook))
    if (!extractedText) {
      throw new Error("Dit Excel-bestand bevat geen leesbare celinhoud.")
    }
    return extractedText
  }

  const extractedText = sanitizeAttachmentText(buffer.toString("utf8"))
  if (!extractedText) {
    throw new Error("Dit tekstbestand bevat geen leesbare inhoud.")
  }
  return extractedText
}

async function buildAiAttachmentContext(attachments = []) {
  const normalizedAttachments = normalizeAiPromptAttachments(attachments)
  if (!normalizedAttachments.length) return ""

  const snippets = []
  const readErrors = []
  let remainingChars = MAX_AI_ATTACHMENT_TOTAL_TEXT_CHARS
  let readableAttachmentCount = 0

  for (const attachment of normalizedAttachments) {
    if (remainingChars <= 0) break
    try {
      const extractedText = await extractTextFromAiPromptAttachment(attachment)
      if (!extractedText) continue
      const snippet = extractedText.slice(0, Math.min(MAX_AI_ATTACHMENT_SNIPPET_CHARS, remainingChars)).trim()
      if (!snippet) continue
      readableAttachmentCount += 1
      snippets.push(`Bestand: ${attachment.name}\n${snippet}`)
      remainingChars -= snippet.length
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Onbekende leesfout."
      readErrors.push(`${attachment?.name || "Bijlage"}: ${reason}`)
      console.warn("[AI] bijlage kon niet worden gelezen:", attachment?.name, reason)
    }
  }

  if (!snippets.length || readableAttachmentCount === 0) {
    const extraDetails = readErrors.length ? ` Details: ${readErrors[0]}` : ""
    throw new Error(
      `De bijlagen konden niet goed worden gelezen. Gebruik een PDF, Word-, Excel-, TXT- of CSV-bestand met echte tekstinhoud. Gescande PDF's zonder tekstlaag kunnen we nog niet uitlezen.${extraDetails}`
    )
  }

  return [
    "Gebruik dit bronmateriaal als leidende context.",
    "Baseer vragen en lesopbouw primair op deze inhoud.",
    "Als het bronmateriaal concreter is dan de korte onderwerpzin, volg dan het bronmateriaal.",
    "Wissel nooit van vak, thema of domein tenzij het expliciet in het bronmateriaal staat.",
    snippets.join("\n\n---\n\n"),
  ].join("\n\n")
}

function buildQuestionPrompt({ topic, audience, questionCount, questionFormat = "multiple-choice", extraRules = "", sourceContext = "" }) {
  const requestedFormat = normalizePracticeQuestionFormat(questionFormat)
  const formatExample =
    requestedFormat === "typed"
      ? `{
    "prompt": "Welk gerecht hoort bij Marokko?",
    "questionType": "typed",
    "acceptedAnswers": ["couscous"],
    "displayAnswer": "couscous",
    "explanation": "Couscous is een bekend gerecht uit Marokko.",
    "category": "Woordenschat",
    "imagePrompt": "traditional moroccan couscous dish on a table, realistic classroom-friendly photo",
    "imageAlt": "Een schaal couscous"
  }`
      : requestedFormat === "mixed"
        ? `{
    "prompt": "Welke hoofdstad hoort bij Marokko?",
    "questionType": "multiple-choice",
    "options": ["Rabat", "Casablanca", "Tanger", "Fes"],
    "correctIndex": 0,
    "explanation": "Rabat is de hoofdstad van Marokko.",
    "category": "Aardrijkskunde",
    "imagePrompt": "city view of Rabat Morocco, realistic educational travel photo",
    "imageAlt": "Stadsbeeld van Rabat"
  }`
        : `{
    "prompt": "Welke hoofdstad hoort bij Marokko?",
    "questionType": "multiple-choice",
    "options": ["Rabat", "Casablanca", "Tanger", "Fes"],
    "correctIndex": 0,
    "explanation": "Rabat is de hoofdstad van Marokko.",
    "category": "Aardrijkskunde",
    "imagePrompt": "city view of Rabat Morocco, realistic educational travel photo",
    "imageAlt": "Stadsbeeld van Rabat"
  }`
  const formatRules =
    requestedFormat === "typed"
      ? `
- Maak invulvragen in flashcard-stijl: de leerling ziet de vraag en typt zelf het antwoord.
- Gebruik géén antwoordopties.
- Gebruik per vraag de velden: prompt, acceptedAnswers, displayAnswer, explanation, category, imagePrompt, imageAlt, questionType.
- questionType moet "typed" zijn.
- acceptedAnswers is een array met 1 tot 4 toegestane korte antwoorden.
- displayAnswer is het voorbeeldantwoord dat de docent of leerling later mag zien.
`
      : requestedFormat === "mixed"
        ? `
- Maak een gemengde set: ongeveer de helft meerkeuze en ongeveer de helft invulvragen in flashcard-stijl.
- Meerkeuzevragen gebruiken: prompt, options, correctIndex, explanation, category, imagePrompt, imageAlt, questionType.
- Invulvragen gebruiken: prompt, acceptedAnswers, displayAnswer, explanation, category, imagePrompt, imageAlt, questionType.
- questionType is per vraag "multiple-choice" of "typed".
- Gebruik bij typed-vragen géén options.
`
        : `
- Maak alleen meerkeuzevragen.
- Gebruik per vraag de velden: prompt, options, correctIndex, explanation, category, imagePrompt, imageAlt, questionType.
- questionType moet "multiple-choice" zijn.
`
  return `
Maak precies ${questionCount} quizvragen in het Nederlands voor ${audience}.
Onderwerp:
${topic.trim()}

${sourceContext ? `Bronmateriaal:\n${sourceContext}\n` : ""}

Regels:
- Analyseer eerst welk soort onderwerp dit is en maak inhoudelijk passende vragen.
- Pas taalniveau, moeilijkheid en context aan op de doelgroep.
- Als er bronmateriaal is meegegeven, is dat bronmateriaal leidend.
- Gebruik alleen informatie uit het bronmateriaal of directe, logische afleidingen daarvan.
- Lees bij bronmateriaal eerst de kernbegrippen en hoofdonderwerpen uit de bestanden en baseer daar de vragen direct op.
- Als het bronmateriaal te weinig bruikbare informatie geeft, verbreed dan niet naar een ander thema en ga niet gokken.
- Genereer nooit vragen over een ander vak, ander land, andere religie of ander thema tenzij dat expliciet in het bronmateriaal staat.
- Als het onderwerp basisniveau vraagt, gebruik dan korte zinnen en concrete voorbeelden.
- Als het onderwerp specialistischer is, maak de vragen inhoudelijk preciezer maar nog steeds helder.
- Respectvol en feitelijk.
- Vermijd te algemene placeholder-vragen die alleen het onderwerp herhalen.
- Korte uitleg per vraag.
- Voeg "category", "imagePrompt" en "imageAlt" toe.
- imagePrompt moet echt het kernbegrip of de situatie uit de vraag zichtbaar maken.
- Vermijd vage prompts zoals "educational illustration" zonder inhoud.
- Geen tekst, labels, letters of watermerken in het beeld.
- Alleen als het onderwerp expliciet islamitische kennis of religie behandelt: geen gezichten, personen, profeten of levende wezens afbeelden; kies abstracte, objectgerichte of symbolische visuals.
- Geen markdown, alleen geldige JSON.
${formatRules}
${extraRules}

Formaat:
[
  ${formatExample}
]
`
}

function buildLessonPrompt({
  topic,
  audience,
  lessonModel,
  durationMinutes,
  practiceQuestionCount = 8,
  slideCount = 6,
  includePracticeTest = false,
  includePresentation = false,
  includeVideoPlan = false,
  extraRules = "",
  sourceContext = "",
}) {
  const practiceSection = includePracticeTest
    ? `
- Voeg ook een veld "practiceTest" toe met een oefentoets van precies ${practiceQuestionCount} meerkeuzevragen in hetzelfde onderwerp.
- practiceTest bevat: title, instructions, questions.
- Elke practiceTest-vraag gebruikt exact de velden: prompt, options, correctIndex, explanation, category, imagePrompt, imageAlt.
`
    : `
- Voeg géén practiceTest toe.
`

  const presentationSection = includePresentation
    ? `
- Voeg ook een veld "presentation" toe voor een compacte presentatieset die de docent live kan tonen.
- presentation bevat: title, style, slides.
- slides is een array met precies ${slideCount} dia's.
- Elke dia bevat: id, title, focus, bullets, studentViewText, speakerNotes, imagePrompt, imageAlt.
- studentViewText is compact en bedoeld voor leerlingen.
- imagePrompt moet per dia een concrete, onderwerpgetrouwe illustratie beschrijven.
- Geen tekst, labels, letters of watermerken in de afbeelding.
${includeVideoPlan ? `
- Voeg binnen "presentation" ook een veld "video" toe.
- video bevat: title, summary, studentViewText, scenes.
- scenes is een array met 3 tot 5 scènes.
- Elke scène bevat: title, narration, visualCue, seconds.
- Dit is een video-opzet of script, geen verwijzing naar een extern platform.
` : `
- Voeg géén video-veld toe.
`}
`
    : `
- Voeg géén presentation toe.
`

  return `
Maak een complete interactieve lesopzet in het Nederlands.

Onderwerp:
${topic.trim()}

${sourceContext ? `Bronmateriaal:\n${sourceContext}\n` : ""}

Doelgroep:
${audience}

Lesmodel:
${lessonModel}

Lesduur:
${durationMinutes} minuten

Regels:
- Maak een bruikbare les voor een docent, geen algemene uitleg.
- De les moet direct inzetbaar zijn in een groep.
- Werk het onderwerp concreet uit en blijf dicht bij de invoer van de docent.
- Als er bronmateriaal is meegegeven, is dat bronmateriaal leidend.
- Lees bij bronmateriaal eerst de kernbegrippen en hoofdonderwerpen uit de bestanden en baseer daar de lesfasen direct op.
- Als het bronmateriaal te weinig bruikbare informatie geeft, verbreed dan niet naar een ander vak, land, religie of thema.
- Gebruik geen ander vak of thema dan wat expliciet in de invoer of het bronmateriaal staat.
- Zorg voor afwisseling tussen uitleg, begeleide oefening, interactie en controle van begrip.
- Verwerk minimaal 5 en maximaal 7 lesfasen.
- Elke fase heeft: title, goal, teacherScript, studentActivity, interactivePrompt, checkForUnderstanding, expectedAnswer, keywords, minutes.
- De totale tijd moet ongeveer ${durationMinutes} minuten zijn.
- Gebruik duidelijke, professionele taal.
- Geen markdown, alleen geldige JSON.
${practiceSection}
${presentationSection}
${extraRules}

Formaat:
{
  "title": "korte lestitel",
  "model": "${lessonModel}",
  "lessonGoal": "wat leren leerlingen in deze les",
  "successCriteria": ["criterium 1", "criterium 2", "criterium 3"],
  "materials": ["materiaal 1", "materiaal 2"],
  "phases": [
    {
      "title": "fase",
      "goal": "doel van de fase",
      "teacherScript": "wat de docent zegt of doet",
      "studentActivity": "wat leerlingen doen",
      "interactivePrompt": "korte actieve opdracht of vraag",
      "checkForUnderstanding": "hoe de docent begrip checkt",
      "expectedAnswer": "kort voorbeeld van een goed antwoord van een leerling",
      "keywords": ["woord 1", "woord 2"],
      "minutes": 5
    }
  ]${includePracticeTest ? `,
  "practiceTest": {
    "title": "korte titel voor de oefentoets",
    "instructions": "korte instructie voor leerlingen",
    "questions": []
  }` : ""}${includePresentation ? `,
  "presentation": {
    "title": "titel van de presentatieset",
    "style": "korte stijlomschrijving",
    "slides": [
      {
        "id": "slide-1",
        "title": "titel",
        "focus": "kern van de dia",
        "bullets": ["punt 1", "punt 2"],
        "studentViewText": "korte leerlingtekst",
        "speakerNotes": "korte docentnotitie",
        "imagePrompt": "english image prompt",
        "imageAlt": "nederlandse alt"
      }
    ]${includeVideoPlan ? `,
    "video": {
      "title": "titel van de video-opzet",
      "summary": "korte samenvatting",
      "studentViewText": "korte leerlingtekst",
      "scenes": []
    }` : ""}
  }` : ""}
}
`
}

function buildRepairPrompt({ topic, audience, questionCount, questionFormat = "multiple-choice", brokenOutput, previousIssue, sourceContext = "" }) {
  const requestedFormat = normalizePracticeQuestionFormat(questionFormat)
  const repairSchemaText =
    requestedFormat === "typed"
      ? 'Elk object moet bevatten: prompt, questionType, acceptedAnswers, displayAnswer, explanation, category, imagePrompt, imageAlt.'
      : requestedFormat === "mixed"
        ? 'Elk object moet bevatten: prompt, questionType, explanation, category, imagePrompt, imageAlt, plus ofwel options + correctIndex, ofwel acceptedAnswers + displayAnswer.'
        : 'Elk object moet bevatten: prompt, questionType, options, correctIndex, explanation, category, imagePrompt, imageAlt.'
  return `
Zet de onderstaande AI-output om naar exact geldige JSON voor een quiz.

Onderwerp: ${topic.trim()}
Doelgroep: ${audience}
Aantal vragen: ${questionCount}

${sourceContext ? `Bronmateriaal:\n${sourceContext}\n` : ""}

Probleem dat hersteld moet worden:
${previousIssue}

Regels:
- Geef alleen een JSON-array terug.
- Zorg voor precies ${questionCount} objecten.
- ${repairSchemaText}
- Gebruik questionType alleen als "multiple-choice" of "typed".
- Als questionType "multiple-choice" is, moet options exact 4 items hebben en correctIndex 0, 1, 2 of 3 zijn.
- Als questionType "typed" is, gebruik je géén options en moet acceptedAnswers minstens 1 bruikbaar antwoord hebben.
- Verbeter waar nodig de inhoud zodat de vragen echt over het onderwerp en het bronmateriaal gaan.
- Genereer geen ander vak, ander land, andere religie of ander thema dan wat expliciet in de invoer of het bronmateriaal staat.
- Geen markdown en geen extra tekst.

Te herstellen output:
${String(brokenOutput || "").slice(0, 12000)}
`
}

function buildLessonRepairPrompt({
  topic,
  audience,
  lessonModel,
  durationMinutes,
  practiceQuestionCount = 8,
  slideCount = 6,
  includePracticeTest = false,
  includePresentation = false,
  includeVideoPlan = false,
  brokenOutput,
  previousIssue,
  sourceContext = "",
}) {
  return `
Zet de onderstaande AI-output om naar exact geldige JSON voor een lesopzet.

Onderwerp: ${topic.trim()}
Doelgroep: ${audience}
Lesmodel: ${lessonModel}
Lesduur: ${durationMinutes} minuten

${sourceContext ? `Bronmateriaal:\n${sourceContext}\n` : ""}

Probleem dat hersteld moet worden:
${previousIssue}

Regels:
- Geef alleen één JSON-object terug.
- Gebruik de velden: title, model, lessonGoal, successCriteria, materials, phases.
- phases moet een array zijn met 5 tot 7 objecten.
- Elke fase moet bevatten: title, goal, teacherScript, studentActivity, interactivePrompt, checkForUnderstanding, expectedAnswer, keywords, minutes.
- ${includePracticeTest ? `Voeg ook een geldig "practiceTest" veld toe met title, instructions en precies ${practiceQuestionCount} questions.` : 'Laat het veld "practiceTest" weg.'}
- ${includePresentation ? `Voeg ook een geldig "presentation" veld toe met title, style en precies ${slideCount} slides.` : 'Laat het veld "presentation" weg.'}
${includePresentation ? '- Elke slide moet bevatten: id, title, focus, bullets, studentViewText, speakerNotes, imagePrompt, imageAlt.' : ""}
- ${includePresentation && includeVideoPlan ? 'Voeg binnen presentation ook een geldig "video" veld toe met title, summary, studentViewText en scenes.' : 'Laat een eventueel "video" veld weg.'}
- Houd de les inhoudelijk passend bij het onderwerp.
- Houd de les ook inhoudelijk passend bij het bronmateriaal als dat is meegegeven.
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

async function requestOpenAIText(prompt, systemPrompt = "") {
  if (!openAI) throw new Error("OpenAI is niet geconfigureerd.")
  const response = await openAI.responses.create({
    model: openAIModel,
    input: systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt,
  })
  return response.output_text || ""
}

async function requestGroqText(
  prompt,
  systemPrompt = "Je maakt quizvragen in helder Nederlands. Antwoord uitsluitend met geldige JSON."
) {
  if (!groq) throw new Error("Groq is niet geconfigureerd.")
  const completion = await groq.chat.completions.create({
    model: groqModel,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  })

  return completion.choices?.[0]?.message?.content || ""
}

async function requestProviderText(provider, prompt, timeoutMs, systemPrompt = "") {
  if (provider === "gemini") return withTimeout(requestGeminiText(systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt), timeoutMs)
  if (provider === "groq") return withTimeout(requestGroqText(prompt, systemPrompt || undefined), timeoutMs)
  if (provider === "openai") return withTimeout(requestOpenAIText(prompt, systemPrompt), timeoutMs)
  throw new Error(`Onbekende AI-provider: ${provider}`)
}

function normalizeQuestionsForTopic(rawQuestions, topic, questionFormat = "multiple-choice") {
  const normalized = normalizeQuestions(rawQuestions, { questionFormat }).map((question) => ({
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

function parseQuestionsFromText(text, topic, questionFormat = "multiple-choice") {
  const parsed = JSON.parse(extractJsonArray(text))
  return normalizeQuestionsForTopic(parsed, topic, questionFormat)
}

function normalizeLessonPhaseMinutes(phases, durationMinutes) {
  const safeDuration = Math.max(20, Math.min(90, Number(durationMinutes) || 45))
  const sourceMinutes = phases.map((phase) => Math.max(3, Number(phase.minutes) || Math.round(safeDuration / phases.length)))
  const sourceTotal = sourceMinutes.reduce((sum, value) => sum + value, 0) || phases.length
  let remaining = safeDuration

  return phases.map((phase, index) => {
    if (index === phases.length - 1) {
      return { ...phase, minutes: Math.max(3, remaining) }
    }

    const phasesLeft = phases.length - index - 1
    const minRemaining = phasesLeft * 3
    const scaled = Math.round((sourceMinutes[index] / sourceTotal) * safeDuration)
    const minutes = Math.max(3, Math.min(safeDuration - minRemaining, scaled || 3))
    remaining -= minutes
    return { ...phase, minutes }
  })
}

function buildPresentationSlideText(slide) {
  return [slide?.title, slide?.focus, slide?.studentViewText, ...(Array.isArray(slide?.bullets) ? slide.bullets : [])]
    .filter(Boolean)
    .join(" ")
}

function phaseAnswerLeaksIntoSlide(phase, slide) {
  const slideText = normalizeComparableText(buildPresentationSlideText(slide))
  if (!slideText) return false

  const slideTokens = new Set(tokenizeText(slideText))
  const candidates = [
    normalizeComparableText(phase?.expectedAnswer),
    ...extractAnswerCandidates(phase?.expectedAnswer),
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (!candidate) continue
    if (slideText.includes(candidate)) return true

    const candidateTokens = tokenizeText(candidate).filter((token) => token.length >= 4)
    if (!candidateTokens.length) continue
    const overlap = candidateTokens.filter((token) => slideTokens.has(token)).length
    if (candidateTokens.length === 1 && overlap >= 1) return true
    if (candidateTokens.length > 1 && overlap >= Math.max(1, Math.ceil(candidateTokens.length * 0.5))) return true
  }

  return false
}

function buildInferenceFriendlyPrompt(phase, slide) {
  const rawTopic = String(slide?.title || phase?.title || "").trim()
  const genericTitle = /^(conclusie|summary|samenvatting|slot|afsluiting|intro|introduction|inleiding)$/i.test(rawTopic)
  const topicPart = rawTopic && !genericTitle ? ` over ${rawTopic}` : ""
  return `Leg in je eigen woorden uit wat deze dia laat zien${topicPart}.`
}

function guardLessonAgainstSlideAnswerLeakage(lesson, slides = []) {
  if (!lesson?.phases?.length || !Array.isArray(slides) || !slides.length) return lesson

  const nextPhases = lesson.phases.map((phase, index) => {
    const slide = slides[index]
    if (!slide || !phaseAnswerLeaksIntoSlide(phase, slide)) return phase

    const saferExpectedAnswer =
      String(slide.focus || slide.studentViewText || phase.goal || phase.expectedAnswer || lesson.lessonGoal || "").trim() ||
      phase.expectedAnswer

    return {
      ...phase,
      interactivePrompt: buildInferenceFriendlyPrompt(phase, slide),
      checkForUnderstanding: "Laat leerlingen uitleggen wat deze dia betekent in hun eigen woorden.",
      expectedAnswer: saferExpectedAnswer,
      keywords: uniqueTokens([...(phase.keywords || []), saferExpectedAnswer, slide.focus, slide.studentViewText]).slice(0, 8),
    }
  })

  return {
    ...lesson,
    phases: nextPhases,
  }
}

function normalizeLessonPlan(rawPlan, { topic, audience, lessonModel, durationMinutes }) {
  if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) {
    throw new Error("AI gaf geen bruikbaar lesplan terug.")
  }

  const rawPhases = Array.isArray(rawPlan.phases) ? rawPlan.phases : []
  const phases = rawPhases
    .map((phase, index) => ({
      id: `lesson-phase-${index + 1}`,
      title: String(phase?.title ?? "").trim(),
      goal: String(phase?.goal ?? "").trim(),
      teacherScript: String(phase?.teacherScript ?? "").trim(),
      studentActivity: String(phase?.studentActivity ?? "").trim(),
      interactivePrompt: String(phase?.interactivePrompt ?? "").trim(),
      checkForUnderstanding: String(phase?.checkForUnderstanding ?? "").trim(),
      expectedAnswer: String(phase?.expectedAnswer ?? "").trim(),
      keywords: (Array.isArray(phase?.keywords) ? phase.keywords : [])
        .map((item) => String(item).trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 8),
      minutes: Number(phase?.minutes) || 0,
    }))
    .filter((phase) => phase.title && phase.goal && phase.studentActivity)

  if (phases.length < 4) {
    throw new Error("AI gaf te weinig bruikbare lesfasen terug.")
  }

  const safeDuration = Math.max(20, Math.min(90, Number(durationMinutes) || 45))
  const normalizedPhases = normalizeLessonPhaseMinutes(phases.slice(0, 7), safeDuration)

  return {
    title: String(rawPlan.title ?? "").trim() || `Les over ${topic.trim()}`,
    model: String(rawPlan.model ?? lessonModel ?? "EDI").trim() || "EDI",
    audience: String(rawPlan.audience ?? audience ?? "vmbo").trim() || "vmbo",
    durationMinutes: safeDuration,
    lessonGoal: String(rawPlan.lessonGoal ?? "").trim() || `Leerlingen werken aan ${topic.trim()}.`,
    successCriteria: (Array.isArray(rawPlan.successCriteria) ? rawPlan.successCriteria : [])
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 5),
    materials: (Array.isArray(rawPlan.materials) ? rawPlan.materials : [])
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 6),
    phases: normalizedPhases,
    currentPhaseIndex: -1,
  }
}

function normalizePracticeTest(rawPracticeTest, topic, questionCount = 8, questionFormat = "multiple-choice") {
  const safeQuestionCount = Math.max(6, Math.min(24, Number(questionCount) || 8))
  if (!rawPracticeTest || typeof rawPracticeTest !== "object") {
    const fallbackQuestions = buildFallbackQuestions({
      topic,
      questionCount: safeQuestionCount,
      questionFormat,
    }).slice(0, safeQuestionCount)
    return {
      title: `Oefentoets over ${topic.trim()}`,
      instructions: "Maak deze oefentoets zelfstandig en bespreek daarna de antwoorden klassikaal.",
      questionFormat: normalizePracticeQuestionFormat(questionFormat),
      questions: fallbackQuestions,
    }
  }

  const normalizedQuestions = normalizeQuestionsForTopic(
    rawPracticeTest.questions,
    topic,
    questionFormat
  )

  if (!normalizedQuestions.length) return null

  return {
    title: String(rawPracticeTest.title ?? "").trim() || `Oefentoets over ${topic.trim()}`,
    instructions:
      String(rawPracticeTest.instructions ?? "").trim() ||
      "Maak deze oefentoets zelfstandig en bespreek daarna de antwoorden klassikaal.",
    questionFormat: normalizePracticeQuestionFormat(rawPracticeTest.questionFormat || questionFormat),
    questions: normalizedQuestions.slice(0, safeQuestionCount),
  }
}

function normalizePresentationPackage(rawPresentation, lesson, { includeVideoPlan = false, slideCount = 6 } = {}) {
  const safeSlideCount = Math.max(4, Math.min(7, Number(slideCount) || 6))
  const safePresentation =
    rawPresentation && typeof rawPresentation === "object" && !Array.isArray(rawPresentation)
      ? rawPresentation
      : {}

  const slides = (Array.isArray(safePresentation.slides) ? safePresentation.slides : [])
    .map((slide, index) => ({
      id: String(slide?.id ?? `slide-${index + 1}`).trim() || `slide-${index + 1}`,
      title: String(slide?.title ?? "").trim(),
      focus: String(slide?.focus ?? "").trim(),
      bullets: (Array.isArray(slide?.bullets) ? slide.bullets : [])
        .map((item) => String(item).trim())
        .filter(Boolean)
        .slice(0, 4),
      studentViewText: String(slide?.studentViewText ?? "").trim(),
      speakerNotes: String(slide?.speakerNotes ?? "").trim(),
      imagePrompt: ensureSlideImagePrompt({
        lessonTitle: lesson.title,
        slideTitle: slide?.title,
        focus: slide?.focus || slide?.studentViewText,
        existingPrompt: slide?.imagePrompt,
      }),
      imageAlt: String(slide?.imageAlt ?? "").trim() || `${String(slide?.title ?? "").trim()} dia`,
      manualImageUrl: sanitizeManualImageUrl(slide?.manualImageUrl || ""),
      manualImageSourceUrl: String(slide?.manualImageSourceUrl ?? "").trim(),
      manualImageSourceImageUrl: String(slide?.manualImageSourceImageUrl ?? "").trim(),
      manualImageSearchQuery: String(slide?.manualImageSearchQuery ?? "").trim(),
      manualImageSourceTitle: String(slide?.manualImageSourceTitle ?? "").trim(),
      manualImageSearchAttempt: Math.max(0, Number(slide?.manualImageSearchAttempt) || 0),
      manualImageSourceHistory: sanitizeImageSourceHistory(slide?.manualImageSourceHistory || []),
    }))
    .filter((slide) => slide.title && (slide.bullets.length || slide.studentViewText || slide.focus))
    .slice(0, safeSlideCount)

  const fallbackSlides =
    slides.length > 0
      ? slides
      : lesson.phases.map((phase, index) => ({
          id: `slide-${index + 1}`,
          title: phase.title,
          focus: phase.goal,
          bullets: [phase.goal, phase.studentActivity].filter(Boolean).slice(0, 3),
          studentViewText: phase.goal || phase.studentActivity,
          speakerNotes: phase.teacherScript,
          imagePrompt: ensureSlideImagePrompt({
            lessonTitle: lesson.title,
            slideTitle: phase.title,
            focus: phase.goal,
          }),
          imageAlt: `${phase.title} dia`,
          manualImageUrl: "",
          manualImageSourceUrl: "",
          manualImageSourceImageUrl: "",
          manualImageSearchQuery: "",
          manualImageSourceTitle: "",
          manualImageSearchAttempt: 0,
          manualImageSourceHistory: [],
        })).slice(0, safeSlideCount)

  const rawVideo = safePresentation.video
  const video =
    includeVideoPlan && rawVideo && typeof rawVideo === "object"
      ? {
          title: String(rawVideo.title ?? "").trim() || `Video-uitleg bij ${lesson.title}`,
          summary: String(rawVideo.summary ?? "").trim() || lesson.lessonGoal,
          studentViewText:
            String(rawVideo.studentViewText ?? "").trim() ||
            "Kijk mee naar de kern van deze uitleg en let op de begrippen die straks terugkomen.",
          scenes: (Array.isArray(rawVideo.scenes) ? rawVideo.scenes : [])
            .map((scene, index) => ({
              id: String(scene?.id ?? `scene-${index + 1}`).trim() || `scene-${index + 1}`,
              title: String(scene?.title ?? "").trim(),
              narration: String(scene?.narration ?? "").trim(),
              visualCue: String(scene?.visualCue ?? "").trim(),
              seconds: Math.max(8, Math.min(60, Number(scene?.seconds) || 18)),
            }))
            .filter((scene) => scene.title && scene.narration)
            .slice(0, 5),
        }
      : null

  const fallbackVideo =
    includeVideoPlan
      ? {
          title: `Video-opzet bij ${lesson.title}`,
          summary: lesson.lessonGoal,
          studentViewText: "Kijk en luister mee naar de kern van deze uitleg. Let op de begrippen die straks terugkomen.",
          scenes: lesson.phases.slice(0, 4).map((phase, index) => ({
            id: `scene-${index + 1}`,
            title: phase.title,
            narration: phase.teacherScript || phase.goal,
            visualCue: phase.studentActivity || phase.checkForUnderstanding || phase.goal,
            seconds: 18,
          })),
        }
      : null

  return {
    title: String(safePresentation.title ?? "").trim() || `Presentatie bij ${lesson.title}`,
    style: String(safePresentation.style ?? "").trim() || "Interactieve uitleg",
    slides: fallbackSlides,
    video: video?.scenes?.length ? video : fallbackVideo?.scenes?.length ? fallbackVideo : null,
  }
}

function normalizeLessonPackage(
  rawPlan,
  {
    topic,
    audience,
    lessonModel,
    durationMinutes,
    practiceQuestionCount = 8,
    practiceQuestionFormat = "multiple-choice",
    slideCount = 6,
    includePracticeTest = false,
    includePresentation = false,
    includeVideoPlan = false,
  }
) {
  if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) {
    throw new Error("AI gaf geen bruikbare lesopzet terug.")
  }

  const lessonSource =
    rawPlan.lesson && typeof rawPlan.lesson === "object" && !Array.isArray(rawPlan.lesson)
      ? rawPlan.lesson
      : rawPlan

  let lesson = normalizeLessonPlan(lessonSource, { topic, audience, lessonModel, durationMinutes })
  let practiceTest = null
  let presentation = null

  if (includePracticeTest) {
    try {
      practiceTest = normalizePracticeTest(rawPlan.practiceTest, topic, practiceQuestionCount, practiceQuestionFormat)
    } catch (error) {
      console.warn(
        `[AI] oefentoets is overgeslagen: ${error instanceof Error ? error.message : "onbekende normalisatiefout"}`
      )
    }
  }

  if (includePresentation) {
    try {
      presentation = normalizePresentationPackage(rawPlan.presentation, lesson, { includeVideoPlan, slideCount })
      lesson = guardLessonAgainstSlideAnswerLeakage(lesson, presentation?.slides || [])
    } catch (error) {
      console.warn(
        `[AI] presentatieset is overgeslagen: ${error instanceof Error ? error.message : "onbekende normalisatiefout"}`
      )
    }
  }

  return {
    ...lesson,
    practiceTest,
    presentation,
    includePracticeTest: Boolean(practiceTest),
    includePresentation: Boolean(presentation),
    includeVideoPlan: Boolean(presentation?.video),
  }
}

function parseLessonPlanFromText(text, options) {
  const parsed = JSON.parse(extractJsonObject(text))
  return normalizeLessonPackage(parsed, options)
}

function tokenizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
}

function uniqueTokens(values) {
  return [...new Set(values.flatMap((value) => tokenizeText(value)))]
}

function normalizeComparableText(value) {
  return tokenizeText(value).join(" ").trim()
}

function stripCommonAnswerLeadIn(value = "") {
  return normalizeComparableText(value)
    .replace(/^(het antwoord is|antwoord is|ik denk dat|ik denk|ik gok dat|ik gok|dat is|dit is|the answer is|it is)\s+/i, "")
    .trim()
}

function cleanSelfPracticeTopicLabel(value = "") {
  const segments = String(value || "")
    .split(/[\n.!?]+/)
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean)

  const cleanupRules = [
    /^(maak|genereer)\s+(voor\s+mij\s+)?(een\s+)?(oefentoets|oefenvragen|oefenopgaven|quiz|flashcards?)\s+(over|van|rond|voor)\s+/i,
    /^(bereid|help)\s+(me|mij)\s+(goed\s+)?voor\s+(op|voor)\s+/i,
    /^(ik\s+heb\s+(een\s+)?)?(schriftelijke\s+overhoring|overhoring|toets|proefwerk|mondeling|examen)\s+(over|van)\s+/i,
    /^(het\s+vak|vak|onderwerp)\s+/i,
    /^(over|van)\s+/i,
  ]

  for (const segment of segments) {
    let cleaned = segment
    for (const rule of cleanupRules) {
      cleaned = cleaned.replace(rule, "")
    }
    cleaned = cleaned.trim().replace(/\s+/g, " ")
    if (cleaned.length >= 2) {
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
    }
  }

  const fallback = String(value || "").trim().replace(/\s+/g, " ")
  return fallback ? fallback.charAt(0).toUpperCase() + fallback.slice(1) : "Algemeen onderwerp"
}

function extractAnswerCandidates(value) {
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

function matchesExpectedCandidate(response, candidate) {
  const normalizedResponse = stripCommonAnswerLeadIn(response)
  const normalizedCandidate = stripCommonAnswerLeadIn(candidate)

  if (!normalizedResponse || !normalizedCandidate) return false
  if (normalizedResponse === normalizedCandidate) return true

  const responseTokens = tokenizeText(normalizedResponse)
  const candidateTokens = tokenizeText(normalizedCandidate)

  if (responseTokens.length === 1 && candidateTokens.length === 2) {
    const [article, core] = candidateTokens
    if (["de", "het", "een", "the", "a", "an"].includes(article) && responseTokens[0] === core) return true
  }
  if (candidateTokens.length === 1 && responseTokens.length === 2) {
    const [article, core] = responseTokens
    if (["de", "het", "een", "the", "a", "an"].includes(article) && candidateTokens[0] === core) return true
  }

  return false
}

function evaluateLessonResponseHeuristic(lesson, phase, responseText) {
  const response = String(responseText || "").trim()
  if (!response) {
    return {
      isCorrect: false,
      label: "Nog niet",
      feedback: "Nog geen antwoord ontvangen.",
    }
  }

  const expectedTokens = uniqueTokens([
    ...(lesson.activeKeywords || phase.keywords || []),
    getActiveLessonExpectedAnswer(lesson),
    phase.goal,
    phase.checkForUnderstanding,
  ])
  const responseTokens = uniqueTokens([response])
  const expectedCandidates = [
    ...(lesson.activeKeywords || []),
    ...(phase.keywords || []),
    ...extractAnswerCandidates(getActiveLessonExpectedAnswer(lesson)),
    ...extractAnswerCandidates(phase.expectedAnswer),
  ]

  if (responseTokens.length === 0 || expectedTokens.length === 0) {
    return {
      isCorrect: response.length >= 12,
      label: response.length >= 12 ? "Goed" : "Bijna",
      feedback:
        response.length >= 12
          ? "Er staat een inhoudelijk antwoord. Bespreek het klassikaal kort na."
          : "Laat de leerling het antwoord iets concreter formuleren.",
    }
  }

  if (expectedCandidates.some((candidate) => matchesExpectedCandidate(response, candidate))) {
    return {
      isCorrect: true,
      label: "Goed",
      feedback: "Dit antwoord raakt direct een kernbegrip van deze lesfase.",
    }
  }

  const matches = responseTokens.filter((token) => expectedTokens.includes(token))
  const ratio = matches.length / Math.max(1, Math.min(expectedTokens.length, 5))

  if (responseTokens.length <= 2 && responseTokens.every((token) => expectedTokens.includes(token))) {
    return {
      isCorrect: true,
      label: "Goed",
      feedback: "Dit antwoord is kort, maar inhoudelijk passend bij de kern van de vraag.",
    }
  }

  if (ratio >= 0.5 || matches.length >= 3) {
    return {
      isCorrect: true,
      label: "Goed",
      feedback: "Dit antwoord sluit goed aan bij de kern van deze lesfase.",
    }
  }

  if (ratio >= 0.25 || matches.length >= 1) {
    return {
      isCorrect: false,
      label: "Bijna",
      feedback: `Er zit iets goeds in. Laat de leerling nog aanvullen met: ${phase.expectedAnswer || phase.checkForUnderstanding || lesson.lessonGoal}.`,
    }
  }

  return {
    isCorrect: false,
    label: "Nog niet",
    feedback: `Dit antwoord mist nog de kern. Verwacht ongeveer: ${phase.expectedAnswer || phase.checkForUnderstanding || lesson.lessonGoal}.`,
  }
}

function normalizeEvaluationLabel(value) {
  const normalized = String(value || "").trim().toLowerCase()
  if (normalized.startsWith("goed")) return "Goed"
  if (normalized.startsWith("bijna")) return "Bijna"
  return "Nog niet"
}

function lessonEvaluationCacheKey({ prompt, expectedAnswer, response }) {
  return [
    normalizeComparableText(prompt),
    normalizeComparableText(expectedAnswer),
    normalizeComparableText(response),
  ].join("||")
}

function rememberLessonEvaluation(key, value) {
  if (!key) return
  if (lessonEvaluationCache.has(key)) {
    lessonEvaluationCache.delete(key)
  }
  lessonEvaluationCache.set(key, value)
  if (lessonEvaluationCache.size > LESSON_EVALUATION_CACHE_LIMIT) {
    const oldestKey = lessonEvaluationCache.keys().next().value
    if (oldestKey) lessonEvaluationCache.delete(oldestKey)
  }
}

function buildLessonEvaluationPrompt({ lesson, phase, responseText, heuristic }) {
  return `
Beoordeel een kort leerlingantwoord voor een lesfase.

Onderwerp van de les:
${lesson.title || lesson.lessonGoal}

Lesdoel:
${lesson.lessonGoal}

Huidige fase:
${phase.title}

Vraag of opdracht:
${getActiveLessonPrompt(lesson) || phase.interactivePrompt || phase.goal}

Verwacht antwoord:
${getActiveLessonExpectedAnswer(lesson) || phase.expectedAnswer || phase.checkForUnderstanding || lesson.lessonGoal}

Extra sleutelwoorden:
${[...(phase.keywords || []), ...(lesson.activeKeywords || [])].filter(Boolean).join(", ") || "geen"}

Leerlingantwoord:
${String(responseText || "").trim()}

Heuristische eerste inschatting:
${JSON.stringify(heuristic)}

Beoordelingsregels:
- Kijk naar betekenis, niet naar hoofdletters, spelling, leestekens of woordvolgorde.
- Synoniemen en parafrases die inhoudelijk hetzelfde betekenen tellen als Goed.
- Als de vraag vraagt om één begrip of één voorbeeld, dan mag één correct kernbegrip voldoende zijn voor Goed.
- Gebruik Bijna alleen als het antwoord deels raak is maar nog belangrijke informatie mist.
- Gebruik Nog niet alleen als het antwoord inhoudelijk niet passend is.
- Geef korte, leerlingvriendelijke feedback in het Nederlands.
- Geef alleen geldige JSON terug.

Formaat:
{
  "label": "Goed",
  "feedback": "korte feedback"
}
`
}

function parseLessonEvaluationFromText(text) {
  const parsed = JSON.parse(extractJsonObject(text))
  const label = normalizeEvaluationLabel(parsed?.label)
  const feedback = String(parsed?.feedback ?? "").trim()

  return {
    isCorrect: label === "Goed",
    label,
    feedback:
      feedback ||
      (label === "Goed"
        ? "Dit antwoord is inhoudelijk goed."
        : label === "Bijna"
          ? "Dit antwoord zit in de goede richting, maar kan nog preciezer."
          : "Dit antwoord past nog niet goed genoeg bij de kern van de vraag."),
  }
}

async function evaluateLessonResponseWithAI(lesson, phase, responseText, heuristic) {
  const prompt = buildLessonEvaluationPrompt({ lesson, phase, responseText, heuristic })
  const systemPrompt = "Je beoordeelt leerlingantwoorden voor een les. Kijk naar betekenis en antwoord alleen met geldige JSON."
  const attempts = [
    ...(genAI ? ["gemini"] : []),
    ...(groq ? ["groq"] : []),
    ...(openAI ? ["openai"] : []),
  ]

  const errors = []
  for (const provider of attempts) {
    try {
      const rawText = await requestProviderText(provider, prompt, AI_RESPONSE_EVALUATION_TIMEOUT_MS, systemPrompt)
      return parseLessonEvaluationFromText(rawText)
    } catch (error) {
      const message = error instanceof Error ? error.message : "onbekende fout"
      errors.push(`${provider}: ${message}`)
      console.warn(`[AI] lesantwoord-evaluatie via ${provider} mislukt: ${message}`)
    }
  }

  console.warn(`[AI] lesantwoord-evaluatie teruggevallen op heuristiek: ${errors.join(" | ")}`)
  return heuristic
}

async function evaluateLessonResponse(lesson, phase, responseText) {
  const heuristic = evaluateLessonResponseHeuristic(lesson, phase, responseText)

  if (!responseText?.trim()) return heuristic
  if (heuristic.label === "Goed") return heuristic

  const expectedAnswer = getActiveLessonExpectedAnswer(lesson) || phase.expectedAnswer || phase.checkForUnderstanding || ""
  if (!expectedAnswer.trim()) return heuristic

  const cacheKey = lessonEvaluationCacheKey({
    prompt: getActiveLessonPrompt(lesson) || phase.interactivePrompt || phase.goal,
    expectedAnswer,
    response: responseText,
  })

  const cached = lessonEvaluationCache.get(cacheKey)
  if (cached) return cached

  const evaluated = await evaluateLessonResponseWithAI(lesson, phase, responseText, heuristic)
  rememberLessonEvaluation(cacheKey, evaluated)
  return evaluated
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

const AI_ALIGNMENT_STOPWORDS = new Set([
  "de", "het", "een", "van", "voor", "met", "zonder", "naar", "over", "onder", "tussen", "door", "maar", "want", "zoals",
  "zijn", "haar", "hun", "jouw", "jullie", "deze", "dit", "dat", "daar", "hier", "niet", "wel", "meer", "minder", "ook",
  "dan", "dus", "als", "bij", "uit", "binnen", "buiten", "tegen", "om", "tot", "nog", "eens", "geen", "alleen", "vaak",
  "make", "maak", "vragen", "vraag", "lesson", "battle", "oefentoets", "leerling", "leerlingen", "docent", "klas",
  "onderwerp", "thema", "question", "questions", "topic", "answer", "multiple", "choice", "typed", "mixed", "about",
  "from", "with", "that", "this", "these", "your", "their", "have", "into", "then", "than", "when", "where", "which",
])

function extractAlignmentKeywords(text = "", limit = 18) {
  const counts = new Map()
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (!normalized) return []

  for (const rawToken of normalized.split(" ")) {
    const token = rawToken.trim()
    if (!token || token.length < 4) continue
    if (AI_ALIGNMENT_STOPWORDS.has(token)) continue
    counts.set(token, (counts.get(token) || 0) + 1)
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
    .slice(0, limit)
    .map(([token]) => token)
}

function buildQuestionAlignmentCorpus(questions = []) {
  return (Array.isArray(questions) ? questions : [])
    .map((question) =>
      [
        question?.prompt,
        question?.explanation,
        question?.category,
        question?.displayAnswer,
        ...(Array.isArray(question?.options) ? question.options : []),
        ...(Array.isArray(question?.acceptedAnswers) ? question.acceptedAnswers : []),
      ]
        .filter(Boolean)
        .join(" ")
    )
    .join(" \n ")
}

function buildLessonAlignmentCorpus(lessonPlan = {}) {
  const phases = Array.isArray(lessonPlan?.phases) ? lessonPlan.phases : []
  const slides = Array.isArray(lessonPlan?.presentation?.slides) ? lessonPlan.presentation.slides : []
  const materials = Array.isArray(lessonPlan?.materials) ? lessonPlan.materials : []
  const successCriteria = Array.isArray(lessonPlan?.successCriteria) ? lessonPlan.successCriteria : []

  return [
    lessonPlan?.title,
    lessonPlan?.lessonGoal,
    ...materials,
    ...successCriteria,
    ...phases.flatMap((phase) => [
      phase?.title,
      phase?.goal,
      phase?.teacherScript,
      phase?.studentActivity,
      phase?.interactivePrompt,
      phase?.checkForUnderstanding,
      phase?.expectedAnswer,
      ...(Array.isArray(phase?.keywords) ? phase.keywords : []),
    ]),
    ...slides.flatMap((slide) => [
      slide?.title,
      slide?.focus,
      slide?.studentViewText,
      slide?.speakerNotes,
      ...(Array.isArray(slide?.bullets) ? slide.bullets : []),
    ]),
  ]
    .filter(Boolean)
    .join(" \n ")
}

function ensureAttachmentAlignment({ sourceContext = "", topic = "", generatedText = "", kindLabel = "output" }) {
  if (!String(sourceContext || "").trim()) return

  const sourceKeywords = extractAlignmentKeywords(`${topic}\n${sourceContext}`, 20)
  if (sourceKeywords.length < 3) return

  const generatedLower = String(generatedText || "").toLowerCase()
  const matchedKeywords = sourceKeywords.filter((keyword) => generatedLower.includes(keyword))
  const minimumMatches = Math.min(5, Math.max(3, Math.ceil(sourceKeywords.length / 5)))

  if (matchedKeywords.length >= minimumMatches) return

  throw new Error(
    `De ${kindLabel} sluiten niet goed genoeg aan op het bronmateriaal. Er komen te weinig kernwoorden uit de bijlage terug.`
  )
}

async function generateQuestionsWithProvider(provider, { topic, audience, questionCount, questionFormat = "multiple-choice", sourceContext = "" }) {
  const providerTimeoutMs = AI_PROVIDER_REQUEST_TIMEOUT_MS
  let lastError = null

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const extraRules =
      attempt === 1
        ? ""
        : "\n- Vorige poging was niet bruikbaar. Wees strenger op onderwerpstrouw, correcte JSON en exacte schema-volgorde."

    try {
      console.info(`[AI] ${provider} attempt ${attempt} gestart voor onderwerp: ${topic}`)
      const rawText = await requestProviderText(
        provider,
        buildQuestionPrompt({ topic, audience, questionCount, questionFormat, extraRules, sourceContext }),
        providerTimeoutMs
      )

      try {
        const questions = parseQuestionsFromText(rawText, topic, questionFormat)
        ensureAttachmentAlignment({
          sourceContext,
          topic,
          generatedText: buildQuestionAlignmentCorpus(questions),
          kindLabel: "vragen",
        })
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
              questionFormat,
              brokenOutput: rawText,
              previousIssue: parseError instanceof Error ? parseError.message : "output was ongeldig",
              sourceContext,
            }),
            AI_PROVIDER_REPAIR_TIMEOUT_MS
          )
          const repairedQuestions = parseQuestionsFromText(repairedText, topic, questionFormat)
          ensureAttachmentAlignment({
            sourceContext,
            topic,
            generatedText: buildQuestionAlignmentCorpus(repairedQuestions),
            kindLabel: "vragen",
          })
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

async function generateLessonPlanWithProvider(
  provider,
  {
    topic,
    audience,
    lessonModel,
    durationMinutes,
    practiceQuestionCount = 8,
    slideCount = 6,
    includePracticeTest = false,
    includePresentation = false,
    includeVideoPlan = false,
    sourceContext = "",
  }
) {
  const providerTimeoutMs = AI_PROVIDER_REQUEST_TIMEOUT_MS
  let lastError = null

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const extraRules =
      attempt === 1
        ? ""
        : "\n- Vorige poging was niet bruikbaar. Wees concreter, onderwerpstrouwer en geef alleen exact geldige JSON terug."

    try {
      console.info(`[AI] ${provider} lesson attempt ${attempt} gestart voor onderwerp: ${topic}`)
      const rawText = await requestProviderText(
        provider,
        buildLessonPrompt({
          topic,
          audience,
          lessonModel,
          durationMinutes,
          practiceQuestionCount,
          slideCount,
          includePracticeTest,
          includePresentation,
          includeVideoPlan,
          extraRules,
          sourceContext,
        }),
        providerTimeoutMs
      )

      try {
        const lessonPlan = parseLessonPlanFromText(rawText, {
          topic,
          audience,
          lessonModel,
          durationMinutes,
          practiceQuestionCount,
          slideCount,
          includePracticeTest,
          includePresentation,
          includeVideoPlan,
        })
        ensureAttachmentAlignment({
          sourceContext,
          topic,
          generatedText: buildLessonAlignmentCorpus(lessonPlan),
          kindLabel: "lesopzet",
        })
        console.info(`[AI] ${provider} lesson attempt ${attempt} geaccepteerd met ${lessonPlan.phases.length} lesfasen`)
        return lessonPlan
      } catch (parseError) {
        lastError = parseError
        console.warn(`[AI] ${provider} lesson attempt ${attempt} afgekeurd: ${parseError instanceof Error ? parseError.message : "onbekende parsefout"}`)

        try {
          const repairedText = await requestProviderText(
            provider,
            buildLessonRepairPrompt({
              topic,
              audience,
              lessonModel,
              durationMinutes,
              practiceQuestionCount,
              slideCount,
              includePracticeTest,
              includePresentation,
              includeVideoPlan,
              brokenOutput: rawText,
              previousIssue: parseError instanceof Error ? parseError.message : "output was ongeldig",
              sourceContext,
            }),
            AI_PROVIDER_REPAIR_TIMEOUT_MS
          )
          const repairedPlan = parseLessonPlanFromText(repairedText, {
            topic,
            audience,
            lessonModel,
            durationMinutes,
            practiceQuestionCount,
            slideCount,
            includePracticeTest,
            includePresentation,
            includeVideoPlan,
          })
          ensureAttachmentAlignment({
            sourceContext,
            topic,
            generatedText: buildLessonAlignmentCorpus(repairedPlan),
            kindLabel: "lesopzet",
          })
          console.info(`[AI] ${provider} lesson repair-pass geslaagd`)
          return repairedPlan
        } catch (repairError) {
          lastError = repairError
          console.warn(`[AI] ${provider} lesson repair-pass mislukt: ${repairError instanceof Error ? repairError.message : "onbekende repairfout"}`)
        }
      }
    } catch (providerError) {
      lastError = providerError
      console.warn(`[AI] ${provider} lesson attempt ${attempt} request-fout: ${providerError instanceof Error ? providerError.message : "onbekende providerfout"}`)
      const retrySeconds = retryDelaySecondsFromError(providerError)
      if (retrySeconds && retrySeconds <= 5 && attempt < 2) {
        await sleep(retrySeconds * 1000)
      }
    }
  }

  throw lastError ?? new Error(`${provider} kon geen bruikbaar lesplan genereren.`)
}

async function generateQuestionsWithGemini(topic, audience, questionCount, questionFormat = "multiple-choice", sourceContext = "") {
  return generateQuestionsWithProvider("gemini", { topic, audience, questionCount, questionFormat, sourceContext })
}

async function generateQuestionsWithGroq(topic, audience, questionCount, questionFormat = "multiple-choice", sourceContext = "") {
  return generateQuestionsWithProvider("groq", { topic, audience, questionCount, questionFormat, sourceContext })
}

async function generateQuestionsWithOpenAI(topic, audience, questionCount, questionFormat = "multiple-choice", sourceContext = "") {
  return generateQuestionsWithProvider("openai", { topic, audience, questionCount, questionFormat, sourceContext })
}

async function generateLessonPlan({
  topic,
  audience,
  lessonModel,
  durationMinutes,
  practiceQuestionCount = 8,
  slideCount = 6,
  includePracticeTest = false,
  includePresentation = false,
  includeVideoPlan = false,
  sourceContext = "",
}) {
  if (!genAI && !groq && !openAI) throw new Error("Er is geen AI-provider geconfigureerd op de server.")
  if (!topic?.trim()) throw new Error("Voer eerst een onderwerp of thema in.")

  const safeDuration = Math.max(20, Math.min(90, Number(durationMinutes) || 45))
  const targetAudience = audience?.trim() || "vmbo"
  const targetModel = String(lessonModel ?? "edi").trim() || "edi"
  const preferredProviderOrder = String(sourceContext || "").trim() ? ["openai", "gemini", "groq"] : ["gemini", "openai", "groq"]
  const attempts = preferredProviderOrder
    .filter((provider) => (provider === "openai" ? Boolean(openAI) : provider === "gemini" ? Boolean(genAI) : Boolean(groq)))
    .map((provider) => ({
      name: provider,
      run: () =>
        generateLessonPlanWithProvider(provider, {
          topic,
          audience: targetAudience,
          lessonModel: targetModel,
          durationMinutes: safeDuration,
          practiceQuestionCount,
          slideCount,
          includePracticeTest,
          includePresentation,
          includeVideoPlan,
          sourceContext,
        }),
    }))

  const errors = []
  for (let index = 0; index < attempts.length; index += 1) {
    const provider = attempts[index]
    try {
      if (index > 0) {
        console.warn(`[AI] ${attempts[index - 1].name} lesgeneratie gefaald, probeer ${provider.name} fallback.`)
      }
      const lesson = await provider.run()
      return {
        lesson,
        provider: provider.name,
        providerLabel: formatProviderLabel(provider.name),
      }
    } catch (providerError) {
      errors.push(`${provider.name}: ${providerError instanceof Error ? providerError.message : "onbekende fout"}`)
      console.warn(`[AI] lesprovider ${provider.name} definitief afgekeurd`)
    }
  }

  throw new Error(errors.join(" | "))
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

async function generateQuestions({ topic, audience, questionCount, questionFormat = "multiple-choice", sourceContext = "" }) {
  if (!genAI && !groq && !openAI) throw new Error("Er is geen AI-provider geconfigureerd op de server.")
  if (!topic?.trim()) throw new Error("Voer eerst een onderwerp of thema in.")

  const safeQuestionCount = Math.max(6, Math.min(24, Number(questionCount) || 12))
  const targetAudience = audience?.trim() || "vmbo"
  const requestedFormat = normalizePracticeQuestionFormat(questionFormat)
  const preferredProviderOrder = String(sourceContext || "").trim() ? ["openai", "gemini", "groq"] : ["gemini", "openai", "groq"]
  const attempts = preferredProviderOrder
    .filter((provider) => (provider === "openai" ? Boolean(openAI) : provider === "gemini" ? Boolean(genAI) : Boolean(groq)))
    .map((provider) => ({
      name: provider,
      run: () =>
        provider === "openai"
          ? generateQuestionsWithOpenAI(topic, targetAudience, safeQuestionCount, requestedFormat, sourceContext)
          : provider === "gemini"
            ? generateQuestionsWithGemini(topic, targetAudience, safeQuestionCount, requestedFormat, sourceContext)
            : generateQuestionsWithGroq(topic, targetAudience, safeQuestionCount, requestedFormat, sourceContext),
    }))

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

restoreRoomsFromDisk()

app.get("/api/question-image", async (req, res) => {
  const prompt = String(req.query.prompt ?? "").trim()
  const category = String(req.query.category ?? "").trim()
  const kind = String(req.query.kind ?? "question").trim().toLowerCase() === "slide" ? "slide" : "question"
  const signature = String(req.query.sig ?? "").trim()
  const ipAddress = String(req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
  if (!prompt) {
    res.status(400).json({ error: "prompt is verplicht" })
    return
  }
  if (hasTooManyInvalidImageSignatures(ipAddress)) {
    res.status(429).json({ error: "Te veel ongeldige afbeeldingsverzoeken. Probeer het later opnieuw." })
    return
  }
  const expectedSignature = buildImageSignature({ prompt, category, kind })
  const signatureIsValid =
    signature &&
    signature.length === expectedSignature.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  if (!signatureIsValid) {
    noteInvalidImageSignature(ipAddress)
    res.status(403).json({ error: "Ongeldige afbeeldingshandtekening." })
    return
  }

  const cachePath = imageCacheFilePath({ prompt, category, kind })
  const cachedBuffer = kind === "slide" ? null : readCachedImageBuffer(cachePath)
  if (cachedBuffer) {
    res.setHeader("Content-Type", "image/png")
    res.setHeader("Cache-Control", "public, max-age=86400")
    res.setHeader("X-Image-Source", "cache")
    res.status(200).send(cachedBuffer)
    return
  }

  try {
    const referenceImage = await searchReusableReferenceImage({ prompt, category, kind })
    if (referenceImage?.buffer) {
      res.setHeader("Content-Type", referenceImage.contentType || "image/jpeg")
      res.setHeader("Cache-Control", "public, max-age=86400")
      res.setHeader("X-Image-Source", referenceImage.source || "wikimedia-commons")
      res.status(200).send(referenceImage.buffer)
      return
    }
  } catch (error) {
    console.warn("[images] reusable image search failed:", error instanceof Error ? error.message : error)
  }

  if (kind === "slide") {
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8")
    res.setHeader("Cache-Control", "public, max-age=3600")
    res.setHeader("X-Image-Source", "fallback")
    res.status(200).send(buildQuestionSvg({ prompt, category }))
    return
  }

  try {
    const aiImage = await generateAIImageResult({ prompt, category, kind })
    if (aiImage?.buffer) {
      writeCachedImageBuffer(cachePath, aiImage.buffer)
      res.setHeader("Content-Type", "image/png")
      res.setHeader("Cache-Control", "public, max-age=86400")
      res.setHeader("X-Image-Source", aiImage.source || "ai")
      res.status(200).send(aiImage.buffer)
      return
    }
  } catch (error) {
    console.warn("[images] AI image generation failed:", error instanceof Error ? error.message : error)
  }

  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8")
  res.setHeader("Cache-Control", "public, max-age=3600")
  res.setHeader("X-Image-Source", "fallback")
  res.status(200).send(buildQuestionSvg({ prompt, category }))
})

app.post("/api/host/presentation-image-upload", async (req, res) => {
  const sessionToken = String(req.body?.sessionToken || "").trim()
  const session = getHostSessionByToken(sessionToken)
  if (!session) {
    res.status(401).json({ message: "Je docentsessie is verlopen. Log opnieuw in." })
    return
  }

  const roomCode = String(session.roomCode || "").trim().toUpperCase()
  const room = roomCode ? rooms.get(roomCode) || null : null
  if (!room || room.game.mode !== "lesson" || !room.lesson?.presentation?.slides?.length) {
    res.status(409).json({ message: "Er staat nu geen actieve presentatie klaar voor upload." })
    return
  }

  try {
    const payload = await updatePresentationSlideManualImage({
      room,
      slideId: req.body?.slideId,
      imageAlt: req.body?.imageAlt,
      uploadDataUrl: req.body?.uploadDataUrl,
      imageUrl: "",
    })
    rememberHostRoomForSession(session, room.code)
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit("host:presentation-image:success", payload)
    }
    res.json(payload)
  } catch (error) {
    res.status(400).json({
      message: error instanceof Error ? error.message : "De afbeelding kon niet worden opgeslagen.",
    })
  }
})

app.post("/api/host/question-image-upload", async (req, res) => {
  const sessionToken = String(req.body?.sessionToken || "").trim()
  const session = getHostSessionByToken(sessionToken)
  if (!session) {
    res.status(401).json({ message: "Je docentsessie is verlopen. Log opnieuw in." })
    return
  }

  const roomCode = String(session.roomCode || "").trim().toUpperCase()
  const room = roomCode ? rooms.get(roomCode) || null : null
  if (!room || !currentQuestion(room)) {
    res.status(409).json({ message: "Er staat nu geen actieve vraag klaar voor upload." })
    return
  }

  try {
    const payload = await updateCurrentQuestionManualImage({
      room,
      imageAlt: req.body?.imageAlt,
      uploadDataUrl: req.body?.uploadDataUrl,
      imageUrl: "",
    })
    rememberHostRoomForSession(session, room.code)
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit("host:question-image:success", payload)
    }
    res.json(payload)
  } catch (error) {
    res.status(400).json({
      message: error instanceof Error ? error.message : "De afbeelding kon niet worden opgeslagen.",
    })
  }
})

ensureManualImagesDir()
app.use("/manual-images", express.static(manualImagesPath))

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

  socket.on("host:login", async ({ username, password, roomCode }) => {
    const account = authenticateTeacherAccount(username, password)
    if (!account) {
      socket.emit("host:error", { message: "Onjuiste docentgegevens." })
      return
    }

    const requestedCode = String(roomCode ?? "").trim().toUpperCase()
    let reclaimableRoom = requestedCode ? rooms.get(requestedCode) : null
    if (!reclaimableRoom && requestedCode) {
      reclaimableRoom = await restoreMathRoomFromCloud(requestedCode)
    }
    const room = reclaimableRoom ?? getRoomBySocketId(socket.id) ?? createRoom(socket.id)
    claimRoomForHost(room, socket.id)
    room.ownerUsername = normalizeTeacherUsername(account.username)
    room.ownerDisplayName = String(account.displayName || account.username || "Docent").trim() || "Docent"
    clearHostSession(socket.id, { invalidateToken: true })
    const session = createHostSession(account, room.code)
    rememberHostRoomForSession(session, room.code)
    hostSessions.set(socket.id, session)
    await ensureClassroomsHydratedFromCloud()
    socket.emit("host:login:success", buildHostSessionPayload(session))
    socket.emit("host:room:update", { roomCode: room.code })
    if (room.game.mode === "lesson" && room.lesson?.phases?.length) {
      socket.emit("host:generate-lesson:success", {
        count: room.lesson.phases.length,
        provider: room.game.source || null,
        providerLabel: room.game.providerLabel || null,
        lessonModel: room.lesson.model,
        hasPracticeTest: Boolean(room.lesson.practiceTest?.questions?.length),
        hasPresentation: Boolean(room.lesson.presentation?.slides?.length),
      })
    } else {
      socket.emit("host:generate:success", {
        count: room.questions.length,
        provider: room.game.source || null,
        providerLabel: room.game.providerLabel || null,
      })
    }
    emitClassroomsToSocket(socket)
    emitLessonLibraryToSocket(socket)
    emitSessionHistoryToSocket(socket)
    emitTeacherAccountsToSocket(socket)
    emitStateToRoom(room)
    emitStateToSocket(socket, room)
  })

  socket.on("host:restore-session", async ({ sessionToken, roomCode }) => {
    const session = getHostSessionByToken(sessionToken)
    if (!session) {
      socket.emit("host:error", { message: "Je docentsessie is verlopen. Log opnieuw in." })
      return
    }

    const requestedCode = String(roomCode ?? session.roomCode ?? "").trim().toUpperCase()
    let reclaimableRoom = requestedCode ? rooms.get(requestedCode) : null
    if (!reclaimableRoom && requestedCode) {
      reclaimableRoom = await restoreMathRoomFromCloud(requestedCode)
    }
    let rememberedRoom = session.roomCode ? rooms.get(session.roomCode) : null
    if (!rememberedRoom && session.roomCode) {
      rememberedRoom = await restoreMathRoomFromCloud(session.roomCode)
    }
    const room = reclaimableRoom ?? rememberedRoom ?? getRoomBySocketId(socket.id) ?? createRoom(socket.id)
    const existingSocketSession = hostSessions.get(socket.id) ?? null
    clearHostSession(socket.id, {
      invalidateToken: Boolean(existingSocketSession?.token && existingSocketSession.token !== session.token),
    })
    detachHostSessionTokenFromOtherSockets(session.token, socket.id)
    claimRoomForHost(room, socket.id)
    room.ownerUsername = normalizeTeacherUsername(session.username)
    room.ownerDisplayName = String(session.displayName || session.username || "Docent").trim() || "Docent"
    rememberHostRoomForSession(session, room.code)
    hostSessions.set(socket.id, session)

    await ensureClassroomsHydratedFromCloud()
    socket.emit("host:login:success", buildHostSessionPayload(session))
    socket.emit("host:room:update", { roomCode: room.code })
    if (room.game.mode === "lesson" && room.lesson?.phases?.length) {
      socket.emit("host:generate-lesson:success", {
        count: room.lesson.phases.length,
        provider: room.game.source || null,
        providerLabel: room.game.providerLabel || null,
        lessonModel: room.lesson.model,
        hasPracticeTest: Boolean(room.lesson.practiceTest?.questions?.length),
        hasPresentation: Boolean(room.lesson.presentation?.slides?.length),
      })
    } else {
      socket.emit("host:generate:success", {
        count: room.questions.length,
        provider: room.game.source || null,
        providerLabel: room.game.providerLabel || null,
      })
    }
    emitClassroomsToSocket(socket)
    emitLessonLibraryToSocket(socket)
    emitSessionHistoryToSocket(socket)
    emitTeacherAccountsToSocket(socket)
    emitStateToRoom(room)
    emitStateToSocket(socket, room)
  })

  socket.on("host:backup:restore", ({ snapshot }) => {
    const currentRoom = requireHostRoom(socket)
    if (!currentRoom) return

    const session = getHostSession(socket.id)
    if (!session) {
      socket.emit("host:error", { message: "Je docentsessie is verlopen. Log opnieuw in." })
      return
    }

    const restoredRoom = deserializeRoomSnapshot(snapshot)
    if (!restoredRoom) {
      socket.emit("host:error", { message: "De lokale backup kon niet worden hersteld." })
      return
    }

    const targetCode = String(restoredRoom.code || currentRoom.code).trim().toUpperCase()
    if (rooms.has(targetCode) && targetCode !== currentRoom.code) {
      socket.emit("host:error", { message: "Er draait al een room met deze code. Sluit die eerst af of gebruik later opnieuw herstel." })
      return
    }

    if (currentRoom.code !== targetCode) {
      rooms.delete(currentRoom.code)
    }

    restoredRoom.code = targetCode
    claimRoomForHost(restoredRoom, socket.id)
    restoredRoom.ownerUsername = normalizeTeacherUsername(session.username)
    restoredRoom.ownerDisplayName = String(session.displayName || session.username || "Docent").trim() || "Docent"
    rememberHostRoomForSession(session, restoredRoom.code)
    rooms.set(restoredRoom.code, restoredRoom)
    scheduleRoomClosure(restoredRoom)

    socket.emit("host:room:update", { roomCode: restoredRoom.code })
    socket.emit("host:backup:restore:success", {
      roomCode: restoredRoom.code,
      title:
        restoredRoom.game.mode === "math"
          ? restoredRoom.math?.title || `Rekenroute ${formatMathLevel(restoredRoom.math?.selectedBand || MATH_LEVELS[1])}`
          : restoredRoom.game.topic || "Les of quiz",
    })
    emitStateToRoom(restoredRoom)
    emitStateToSocket(socket, restoredRoom)
  })

  socket.on("host:library:list", () => {
    const room = requireHostRoom(socket)
    if (!room) return
    emitLessonLibraryToSocket(socket)
  })

  socket.on("host:classes:list", async () => {
    const room = requireHostRoom(socket)
    if (!room) return
    await ensureClassroomsHydratedFromCloud()
    emitClassroomsToSocket(socket)
  })

  socket.on("host:history:list", () => {
    const room = requireHostRoom(socket)
    if (!room) return
    emitSessionHistoryToSocket(socket)
  })

  socket.on("host:teacher-accounts:list", () => {
    const room = requireHostRoom(socket)
    if (!room) return
    if (!canManageTeacherAccounts(socket.id)) {
      socket.emit("host:error", { message: "Alleen beheerders kunnen docentaccounts bekijken." })
      return
    }
    emitTeacherAccountsToSocket(socket)
  })

  socket.on("host:classes:create", async ({ name, sectionName, audience }) => {
    const room = requireHostRoom(socket)
    if (!room) return
    await ensureClassroomsHydratedFromCloud()

    const trimmedName = String(name ?? "").trim()
    if (trimmedName.length < 2) {
      socket.emit("host:error", { message: "Geef de klas een naam van minimaal 2 tekens." })
      return
    }
    if (classrooms.some((entry) => normalizeParticipantName(entry.name) === normalizeParticipantName(trimmedName))) {
      socket.emit("host:error", { message: "Er bestaat al een klas met deze naam." })
      return
    }

    const now = new Date().toISOString()
    const nextClassroom = normalizeClassroomEntry({
      id: generateEntityId("classroom"),
      name: trimmedName,
      sectionName: String(sectionName ?? "").trim() || "Algemene sectie",
      audience: String(audience ?? "vmbo").trim() || "vmbo",
      ownerUsername: getRoomOwnerUsername(room),
      ownerDisplayName: room.ownerDisplayName || room.ownerUsername || "Docent",
      learners: [],
      createdAt: now,
      updatedAt: now,
    })
    classrooms = [nextClassroom, ...classrooms]
    persistClassrooms()
    emitClassroomsToHosts()
    if (mathCloudEnabled) {
      await writeClassroomToCloud(nextClassroom).catch((error) => {
        console.error("Kon nieuwe klas niet naar Firestore schrijven:", error instanceof Error ? error.message : error)
      })
    }
    socket.emit("host:classes:success", {
      message: `Klas ${nextClassroom.name} is toegevoegd.`,
    })
  })

  socket.on("host:classes:update", async ({ classId, name, sectionName, audience }) => {
    const room = requireHostRoom(socket)
    if (!room) return
    await ensureClassroomsHydratedFromCloud()

    const currentClassroom = findClassroomById(classId)
    if (!currentClassroom) {
      socket.emit("host:error", { message: "Deze klas bestaat niet meer." })
      return
    }

    const trimmedName = String(name ?? currentClassroom.name).trim()
    if (trimmedName.length < 2) {
      socket.emit("host:error", { message: "Geef de klas een naam van minimaal 2 tekens." })
      return
    }
    if (
      classrooms.some(
        (entry) => entry.id !== currentClassroom.id && normalizeParticipantName(entry.name) === normalizeParticipantName(trimmedName)
      )
    ) {
      socket.emit("host:error", { message: "Er bestaat al een andere klas met deze naam." })
      return
    }

    const nextClassroom = updateClassroomInMemory(currentClassroom.id, (entry) => ({
      ...entry,
      name: trimmedName,
      sectionName: String(sectionName ?? entry.sectionName).trim() || "Algemene sectie",
      audience: String(audience ?? entry.audience).trim() || "vmbo",
      updatedAt: new Date().toISOString(),
    }))
    if (!nextClassroom) {
      socket.emit("host:error", { message: "Deze klas kon niet worden bijgewerkt." })
      return
    }
    syncClassroomMetaAcrossMathRooms(nextClassroom)
    socket.emit("host:classes:success", {
      message: `Klas ${nextClassroom.name} is bijgewerkt.`,
    })
  })

  socket.on("host:classes:delete", async ({ classId }) => {
    const room = requireHostRoom(socket)
    if (!room) return
    await ensureClassroomsHydratedFromCloud()

    const currentClassroom = findClassroomById(classId)
    if (!currentClassroom) {
      socket.emit("host:error", { message: "Deze klas bestaat niet meer." })
      return
    }
    classrooms = classrooms.filter((entry) => entry.id !== currentClassroom.id)
    detachClassroomFromMathRooms(currentClassroom)
    persistClassrooms()
    emitClassroomsToHosts()
    await removeClassroomFromCloud(currentClassroom.id)
    socket.emit("host:classes:success", {
      message: `Klas ${currentClassroom.name} is verwijderd.`,
    })
  })

  socket.on("host:classes:learner:add", async ({ classId, name, learnerCode, studentNumber }) => {
    const room = requireHostRoom(socket)
    if (!room) return
    await ensureClassroomsHydratedFromCloud()

    const classroom = findClassroomById(classId)
    if (!classroom) {
      socket.emit("host:error", { message: "Deze klas bestaat niet meer." })
      return
    }
    const trimmedName = String(name ?? "").trim()
    const normalizedCode = normalizeLearnerCode(learnerCode)
    if (!trimmedName) {
      socket.emit("host:error", { message: "Vul eerst de naam van de leerling in." })
      return
    }
    if (String(learnerCode ?? "").trim() && !isValidLearnerCode(normalizedCode)) {
      socket.emit("host:error", { message: "Gebruik een leerlingcode van precies 4 cijfers." })
      return
    }
    if (normalizedCode && classroom.learners.some((entry) => entry.learnerCode === normalizedCode)) {
      socket.emit("host:error", { message: "Deze leerlingcode is al in gebruik binnen deze klas." })
      return
    }
    const normalizedStudentNumber = normalizeStudentNumber(studentNumber)
    if (normalizedStudentNumber && classroom.learners.some((entry) => normalizeStudentNumber(entry.studentNumber) === normalizedStudentNumber)) {
      socket.emit("host:error", { message: "Dit leerlingnummer is al in gebruik binnen deze klas." })
      return
    }

    const now = new Date().toISOString()
    const nextLearner = normalizeClassroomLearner({
      id: generateEntityId("class-learner"),
      name: trimmedName,
      learnerCode: normalizedCode || generateUniqueClassroomLearnerCode(classroom),
      studentNumber: normalizedStudentNumber || generateNextStudentNumber(classroom.learners.map((entry) => entry.studentNumber)),
      createdAt: now,
      updatedAt: now,
    })
    const nextClassroom = updateClassroomInMemory(classroom.id, (entry) => ({
      ...entry,
      learners: [...entry.learners, nextLearner],
      updatedAt: now,
    }))
    await ensureMathGrowthRecordLoaded(nextLearner.name, nextLearner.learnerCode)
    socket.emit("host:classes:success", {
      message: `Leerling ${nextLearner.name} is toegevoegd aan ${nextClassroom?.name || classroom.name}.`,
    })
  })

  socket.on("host:classes:learner:update", async ({ classId, learnerId, name, learnerCode, studentNumber }) => {
    const room = requireHostRoom(socket)
    if (!room) return
    await ensureClassroomsHydratedFromCloud()

    const classroom = findClassroomById(classId)
    if (!classroom) {
      socket.emit("host:error", { message: "Deze klas bestaat niet meer." })
      return
    }
    const currentLearner = classroom.learners.find((entry) => entry.id === String(learnerId ?? "").trim())
    if (!currentLearner) {
      socket.emit("host:error", { message: "Deze leerling staat niet meer in de klas." })
      return
    }

    const trimmedName = String(name ?? currentLearner.name).trim()
    const normalizedCode = normalizeLearnerCode(learnerCode)
    if (!trimmedName) {
      socket.emit("host:error", { message: "Vul eerst de naam van de leerling in." })
      return
    }
    if (String(learnerCode ?? "").trim() && !isValidLearnerCode(normalizedCode)) {
      socket.emit("host:error", { message: "Gebruik een leerlingcode van precies 4 cijfers." })
      return
    }
    if (normalizedCode && classroom.learners.some((entry) => entry.id !== currentLearner.id && entry.learnerCode === normalizedCode)) {
      socket.emit("host:error", { message: "Deze leerlingcode is al in gebruik binnen deze klas." })
      return
    }
    const normalizedStudentNumber = normalizeStudentNumber(studentNumber)
    if (
      normalizedStudentNumber &&
      classroom.learners.some(
        (entry) => entry.id !== currentLearner.id && normalizeStudentNumber(entry.studentNumber) === normalizedStudentNumber
      )
    ) {
      socket.emit("host:error", { message: "Dit leerlingnummer is al in gebruik binnen deze klas." })
      return
    }

    const now = new Date().toISOString()
    const nextClassroom = updateClassroomInMemory(classroom.id, (entry) => ({
      ...entry,
      learners: entry.learners.map((learnerEntry) =>
        learnerEntry.id === currentLearner.id
          ? {
              ...learnerEntry,
              name: trimmedName,
              learnerCode: normalizedCode || learnerEntry.learnerCode || generateUniqueClassroomLearnerCode(classroom),
              studentNumber:
                normalizedStudentNumber ||
                normalizeStudentNumber(learnerEntry.studentNumber) ||
                generateNextStudentNumber(classroom.learners.map((entry) => entry.studentNumber)),
              updatedAt: now,
            }
          : learnerEntry
      ),
      updatedAt: now,
    }))
    const nextLearner = nextClassroom?.learners.find((entry) => entry.id === currentLearner.id) || null
    if (nextLearner) {
      await migrateClassroomLearnerIdentity(currentLearner.name, currentLearner.learnerCode, nextLearner.name, nextLearner.learnerCode)
      await syncClassroomLearnerAcrossMathRooms(nextClassroom, nextLearner, currentLearner.name, currentLearner.learnerCode)
    }
    socket.emit("host:classes:success", {
      message: `Gegevens van ${trimmedName} zijn bijgewerkt.`,
    })
  })

  socket.on("host:classes:import", async ({ classId, fileName, fileDataBase64 }) => {
    const room = requireHostRoom(socket)
    if (!room) return
    await ensureClassroomsHydratedFromCloud()

    const classroom = findClassroomById(classId)
    if (!classroom) {
      socket.emit("host:error", { message: "Deze klas bestaat niet meer." })
      return
    }

    const normalizedFileName = String(fileName ?? "").trim() || "leerlingenbestand.xlsx"
    const base64Payload = String(fileDataBase64 || "").trim()
    if (!base64Payload) {
      socket.emit("host:error", { message: "Kies eerst een Excel- of CSV-bestand om te importeren." })
      return
    }

    let parsedImport = null
    try {
      parsedImport = parseClassroomLearnerImport(Buffer.from(base64Payload, "base64"), normalizedFileName)
    } catch (error) {
      socket.emit("host:error", {
        message:
          error instanceof Error && error.message
            ? `Dit bestand kon niet worden gelezen. Controleer of het een geldig Excel- of CSV-bestand is. (${error.message})`
            : "Dit bestand kon niet worden gelezen. Controleer of het een geldig Excel- of CSV-bestand is.",
      })
      return
    }

    const importedLearners = Array.isArray(parsedImport?.learners) ? parsedImport.learners : []
    if (!importedLearners.length) {
      socket.emit("host:error", {
        message:
          "In dit bestand vonden we geen leerlingen. Gebruik bij voorkeur kolommen zoals naam, leerlingcode en leerlingnummer.",
      })
      return
    }

    const previousLearnersById = new Map(
      classroom.learners.map((learner) => [
        learner.id,
        {
          name: learner.name,
          learnerCode: learner.learnerCode,
        },
      ])
    )
    const importResult = mergeImportedLearnersIntoClassroom(classroom, importedLearners)
    if (!importResult.addedCount && !importResult.updatedCount) {
      socket.emit("host:classes:success", {
        message: `Import afgerond: er waren geen nieuwe of gewijzigde leerlingen in ${classroom.name}.`,
      })
      return
    }

    const nextClassroom = updateClassroomInMemory(classroom.id, (entry) => ({
      ...entry,
      learners: importResult.nextLearners,
      updatedAt: new Date().toISOString(),
    }))
    if (!nextClassroom) {
      socket.emit("host:error", { message: "De klas kon na het importeren niet worden bijgewerkt." })
      return
    }

    for (const learner of nextClassroom.learners) {
      const previous = previousLearnersById.get(learner.id)
      if (!previous) {
        await ensureMathGrowthRecordLoaded(learner.name, learner.learnerCode)
        continue
      }
      await migrateClassroomLearnerIdentity(previous.name, previous.learnerCode, learner.name, learner.learnerCode)
      await syncClassroomLearnerAcrossMathRooms(nextClassroom, learner, previous.name, previous.learnerCode)
    }

    socket.emit("host:classes:success", {
      message: `Import klaar voor ${nextClassroom.name}: ${importResult.addedCount} toegevoegd, ${importResult.updatedCount} bijgewerkt, ${importResult.skippedCount} overgeslagen.`,
    })
  })

  socket.on("host:classes:learner:delete", async ({ classId, learnerId }) => {
    const room = requireHostRoom(socket)
    if (!room) return
    await ensureClassroomsHydratedFromCloud()

    const classroom = findClassroomById(classId)
    if (!classroom) {
      socket.emit("host:error", { message: "Deze klas bestaat niet meer." })
      return
    }
    const currentLearner = classroom.learners.find((entry) => entry.id === String(learnerId ?? "").trim())
    if (!currentLearner) {
      socket.emit("host:error", { message: "Deze leerling staat niet meer in de klas." })
      return
    }

    updateClassroomInMemory(classroom.id, (entry) => ({
      ...entry,
      learners: entry.learners.filter((learnerEntry) => learnerEntry.id !== currentLearner.id),
      updatedAt: new Date().toISOString(),
    }))
    socket.emit("host:classes:success", {
      message: `Leerling ${currentLearner.name} is uit ${classroom.name} verwijderd.`,
    })
  })

  socket.on("host:teacher-accounts:create", ({ username, password, displayName, role }) => {
    const room = requireHostRoom(socket)
    if (!room) return
    if (!canManageTeacherAccounts(socket.id)) {
      socket.emit("host:error", { message: "Alleen beheerders kunnen docentaccounts toevoegen." })
      return
    }

    const normalizedUsername = normalizeTeacherUsername(username)
    const cleanDisplayName = String(displayName ?? username ?? "").trim() || normalizedUsername
    const cleanPassword = String(password ?? "")
    const requestedRole = String(role ?? "teacher").trim().toLowerCase()
    const nextRole =
      requestedRole === "manager" && isHostOwner(socket.id)
        ? "manager"
        : "teacher"

    if (!normalizedUsername || normalizedUsername.length < 3) {
      socket.emit("host:error", { message: "Kies een gebruikersnaam van minimaal 3 tekens." })
      return
    }
    if (!/^[a-z0-9._-]+$/i.test(normalizedUsername)) {
      socket.emit("host:error", { message: "Gebruik alleen letters, cijfers, punt, liggend streepje of underscore." })
      return
    }
    if (cleanPassword.length < 6) {
      socket.emit("host:error", { message: "Kies een wachtwoord van minimaal 6 tekens." })
      return
    }
    if (normalizedUsername === normalizeTeacherUsername(teacherUsername)) {
      socket.emit("host:error", { message: "Deze gebruikersnaam is al gereserveerd voor het hoofdaccount." })
      return
    }
    if (teacherAccounts.some((account) => account.username === normalizedUsername)) {
      socket.emit("host:error", { message: "Deze docentgebruikersnaam bestaat al." })
      return
    }

    const now = new Date().toISOString()
    const passwordData = hashTeacherPassword(cleanPassword)
    teacherAccounts = [
      {
        id: generateEntityId("teacher"),
        username: normalizedUsername,
        displayName: cleanDisplayName,
        role: nextRole,
        salt: passwordData.salt,
        passwordHash: passwordData.passwordHash,
        createdAt: now,
        updatedAt: now,
      },
      ...teacherAccounts,
    ]

    persistTeacherAccounts()
    emitTeacherAccountsToOwners()
    socket.emit("host:teacher-accounts:success", {
      message: `Docentaccount ${cleanDisplayName} is toegevoegd.`,
    })
  })

  socket.on("host:teacher-accounts:update", ({ accountId, password, displayName, role }) => {
    const room = requireHostRoom(socket)
    if (!room) return
    if (!canManageTeacherAccounts(socket.id)) {
      socket.emit("host:error", { message: "Alleen beheerders kunnen docentaccounts aanpassen." })
      return
    }

    const account = teacherAccounts.find((entry) => entry.id === accountId)
    if (!account) {
      socket.emit("host:error", { message: "Dit docentaccount bestaat niet meer." })
      return
    }

    const cleanDisplayName = String(displayName ?? account.displayName ?? account.username).trim() || account.username
    const cleanPassword = String(password ?? "")
    const nextRole =
      String(role ?? account.role).trim().toLowerCase() === "manager" && isHostOwner(socket.id)
        ? "manager"
        : "teacher"

    account.displayName = cleanDisplayName
    account.role = nextRole
    if (cleanPassword) {
      if (cleanPassword.length < 6) {
        socket.emit("host:error", { message: "Een nieuw wachtwoord moet minimaal 6 tekens hebben." })
        return
      }
      const passwordData = hashTeacherPassword(cleanPassword)
      account.salt = passwordData.salt
      account.passwordHash = passwordData.passwordHash
    }
    account.updatedAt = new Date().toISOString()

    persistTeacherAccounts()
    invalidateHostSessionTokensForUsername(account.username)
    emitTeacherAccountsToOwners()
    socket.emit("host:teacher-accounts:success", {
      message: `Docentaccount ${account.displayName} is bijgewerkt.`,
    })
  })

  socket.on("host:teacher-accounts:delete", ({ accountId }) => {
    const room = requireHostRoom(socket)
    if (!room) return
    if (!canManageTeacherAccounts(socket.id)) {
      socket.emit("host:error", { message: "Alleen beheerders kunnen docentaccounts verwijderen." })
      return
    }

    const account = teacherAccounts.find((entry) => entry.id === accountId)
    if (!account) return

    teacherAccounts = teacherAccounts.filter((entry) => entry.id !== accountId)
    persistTeacherAccounts()
    invalidateHostSessionTokensForUsername(account.username)
    emitTeacherAccountsToOwners()
    socket.emit("host:teacher-accounts:success", {
      message: `Docentaccount ${account.displayName} is verwijderd.`,
    })
  })

  socket.on("host:logout", () => {
    hostSocketIds.delete(socket.id)
    clearHostSession(socket.id, { invalidateToken: true })
    const room = getRoomBySocketId(socket.id)
    socketToRoom.delete(socket.id)
    if (!room) {
      emitStateToSocket(socket, null)
      return
    }

    if (room.hostSocketId === socket.id) {
      scheduleRoomClosure(room)
      emitStateToRoom(room)
    }

    emitStateToSocket(socket, null)
  })

  socket.on("player:lookup-room", async ({ roomCode }) => {
    const normalizedCode = String(roomCode ?? "").trim().toUpperCase()
    let room = rooms.get(normalizedCode)
    if (!room && normalizedCode) {
      room = await restoreMathRoomFromCloud(normalizedCode)
    }
    if (!room) {
      socket.emit("player:room:preview", { valid: false })
      return
    }

    socket.emit("player:room:preview", {
      valid: true,
      roomCode: room.code,
      teams: room.teams,
      status: room.game.status,
      mode: room.game.mode || "battle",
      intakeTotal: room.game.mode === "math" ? room.math?.intakeQuestions?.length || 0 : 0,
      groupModeEnabled: Boolean(room.game.groupModeEnabled),
    })
  })

  socket.on("host:configure", ({ teamNames, groupModeEnabled }) => {
    const room = requireHostRoom(socket)
    if (!room) return
    const nextGroupModeEnabled = applyGroupModeSettings(
      room,
      groupModeEnabled,
      Array.isArray(teamNames) ? teamNames : DEFAULT_TEAMS
    )
    emitStateToRoom(room)
    socket.emit("host:configure:success", {
      teams: room.teams,
      groupModeEnabled: nextGroupModeEnabled,
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
      if (player.socketId) {
        socketToRoom.delete(player.socketId)
        io.to(player.socketId).emit("player:removed", { message: "De sessiecode is vernieuwd. Voer de nieuwe code in." })
      }
    }

    room.players = []
    room.answeredPlayers = new Set()
    room.playerAnswers = new Map()
    room.lessonResponses = new Map()
    room.lesson = createEmptyLessonState()
    room.math = createEmptyMathState()
    room.questions = []
    room.currentQuestionIndex = -1
    room.game = createIdleGameState(Boolean(room.game?.groupModeEnabled))
    rememberHostRoomForSession(getHostSession(socket.id), room.code)
    socket.emit("host:room:update", { roomCode: room.code })
    emitStateToRoom(room)
  })

  socket.on("host:generate", async ({ topic, audience, questionCount, teamNames, questionDurationSec, groupModeEnabled, attachments }) => {
    const room = requireHostRoom(socket)
    if (!room) return

    const safeDuration = Math.max(8, Math.min(60, Number(questionDurationSec) || 20))
    socket.emit("host:generate:started", { message: "AI is bezig met de ronde..." })

    applyGroupModeSettings(room, groupModeEnabled, Array.isArray(teamNames) ? teamNames : DEFAULT_TEAMS)

    let generationResult
    let sourceContext = ""
    try {
      sourceContext = await buildAiAttachmentContext(attachments)
      generationResult = await withTimeout(
        generateQuestions({ topic, audience, questionCount, sourceContext }),
        AI_ROUND_GENERATION_TIMEOUT_MS
      )
      room.questions = generationResult.questions.map((question, index) => ({
        ...question,
        id: question.id || `battle-${index + 1}`,
        prompt: String(question.prompt || question.question_text || "").trim(),
        options: [...(question.options || [])],
        durationSec: safeDuration,
      }))
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
      room.lessonResponses = new Map()
      room.lesson = createEmptyLessonState()
      room.math = createEmptyMathState()
      room.game = {
        ...createIdleGameState(Boolean(room.game?.groupModeEnabled)),
        topic: String(topic ?? "").trim(),
        audience: audience?.trim() || "vmbo",
        questionCount: Number(questionCount) || 12,
        questionDurationSec: safeDuration,
      }
      emitStateToRoom(room)
      socket.emit("host:error", { message: userMessage })
      return
    }

    room.playerAnswers = new Map()
    room.lessonResponses = new Map()
    room.lesson = createEmptyLessonState()
    room.math = createEmptyMathState()
    room.game = {
      ...createIdleGameState(Boolean(room.game?.groupModeEnabled)),
      topic: String(topic ?? "").trim(),
      audience: audience?.trim() || "vmbo",
      questionCount: room.questions.length,
      questionDurationSec: safeDuration,
      questionStartedAt: null,
      status: room.questions.length ? "preview" : "idle",
      answerRevealed: false,
      source: generationResult?.provider || "ai",
      providerLabel: generationResult?.providerLabel || "AI",
      generatedAt: new Date().toISOString(),
      mode: "battle",
    }
    setCurrentQuestionPreview(room, room.questions.length ? 0 : -1)

    recordSessionHistory(buildSessionHistoryEntryFromRoom(room, "battle"))
    emitStateToRoom(room)
    socket.emit("host:generate:success", {
      count: room.questions.length,
      provider: generationResult?.provider || null,
      providerLabel: generationResult?.providerLabel || null,
    })
  })

  socket.on("host:start-math", async ({ band, assignmentTitle, dueAt, classId, targetPracticeQuestionCount }) => {
    const room = requireHostRoom(socket)
    if (!room) return
    await ensureClassroomsHydratedFromCloud()
    const previousMathPlayers = room.game.mode === "math" ? room.players.map((player) => ({ name: player.name, learnerCode: player.learnerCode })) : []

    const selectedBand = normalizeMathLevel(band)
    const selectedClassroom = classId ? findClassroomById(classId) : null
    if (classId && !selectedClassroom) {
      socket.emit("host:error", { message: "De gekozen klas bestaat niet meer." })
      return
    }
    if (selectedClassroom && !selectedClassroom.learners.length) {
      socket.emit("host:error", { message: "Deze klas heeft nog geen leerlingen met leerlingcode." })
      return
    }
    room.questions = []
    room.currentQuestionIndex = -1
    room.answeredPlayers = new Set()
    room.playerAnswers = new Map()
    room.lessonResponses = new Map()
    room.lesson = createEmptyLessonState()
    room.math = buildMathSession(selectedBand, {
      assignmentTitle,
      dueAt,
      classId: selectedClassroom?.id || "",
      className: selectedClassroom?.name || "",
      targetPracticeQuestionCount,
      title: String(assignmentTitle || "").trim() || `Rekenroute ${formatMathLevel(selectedBand)}`,
    })
    const usedMathCodes = new Set()
    room.players = selectedClassroom
      ? selectedClassroom.learners.map((learner) => {
          usedMathCodes.add(learner.learnerCode)
          return createPlayerRecord({
            id: learner.id,
            learnerCode: learner.learnerCode,
            name: learner.name,
            teamId: room.teams[0]?.id || "team-1",
            classId: selectedClassroom.id,
            className: selectedClassroom.name,
            classLearnerId: learner.id,
            score: 0,
            connected: false,
          })
        })
      : room.players.map((player) => {
          let nextLearnerCode = isValidLearnerCode(player.learnerCode) ? player.learnerCode : ""
          if (!nextLearnerCode || usedMathCodes.has(nextLearnerCode)) {
            do {
              nextLearnerCode = String(randomInt(1000, 9999))
            } while (usedMathCodes.has(nextLearnerCode))
          }
          usedMathCodes.add(nextLearnerCode)
          return {
            ...player,
            score: 0,
            learnerCode: nextLearnerCode,
            classId: player.classId || "",
            className: player.className || "",
            classLearnerId: player.classLearnerId || "",
          }
        })
    room.teams = createTeams(["Rekenroute"])
    reassignPlayersToExistingTeams(room)

    for (const player of room.players) {
      ensureMathProgress(room, player.id)
    }
    await Promise.all(room.players.map((player) => ensureMathGrowthRecordLoaded(player.name || "", player.learnerCode || "")))

    room.game = {
      ...createIdleGameState(false),
      topic: selectedClassroom ? `${selectedClassroom.name} · Rekenen ${formatMathLevel(selectedBand)}` : `Rekenen ${formatMathLevel(selectedBand)}`,
      audience: "vmbo",
      status: "live",
      source: "math",
      providerLabel: "Adaptieve rekenroute",
      generatedAt: new Date().toISOString(),
      mode: "math",
      questionCount: 0,
      questionDurationSec: 0,
    }

    emitStateToRoom(room)
    await Promise.all(previousMathPlayers.map((player) => removeMathResumeIndex(player.name, player.learnerCode)))
    await syncMathResumeIndexForRoom(room)
    socket.emit("host:generate:success", {
      count: room.math.intakeQuestions.length,
      provider: "math",
      providerLabel: "Adaptieve rekenroute",
    })
  })

  socket.on("host:generate-lesson", async ({
    topic,
    audience,
    lessonModel,
    durationMinutes,
    slideCount,
    practiceQuestionCount,
    practiceQuestionFormat,
    teamNames,
    groupModeEnabled,
    includePracticeTest,
    includePresentation,
    includeVideoPlan,
    attachments,
  }) => {
    const room = requireHostRoom(socket)
    if (!room) return

    const safeDuration = Math.max(20, Math.min(90, Number(durationMinutes) || 45))
    const safeLessonModel = String(lessonModel ?? "edi").trim() || "edi"
    const safeSlideCount = Math.max(4, Math.min(7, Number(slideCount) || 6))
    const safePracticeQuestionCount = Math.max(6, Math.min(24, Number(practiceQuestionCount) || 8))
    const safePracticeQuestionFormat = normalizePracticeQuestionFormat(practiceQuestionFormat)
    const wantsPracticeTest = Boolean(includePracticeTest)
    const wantsPresentation = Boolean(includePresentation)
    const wantsVideoPlan = Boolean(includePresentation && includeVideoPlan)
    socket.emit("host:generate-lesson:started", { message: "AI bouwt de lesopzet..." })

    applyGroupModeSettings(room, groupModeEnabled, Array.isArray(teamNames) ? teamNames : DEFAULT_TEAMS)

    let lessonResult
    let sourceContext = ""
    try {
      sourceContext = await buildAiAttachmentContext(attachments)
      lessonResult = await withTimeout(
        generateLessonPlan({
          topic,
          audience,
          lessonModel: safeLessonModel,
          durationMinutes: safeDuration,
          slideCount: safeSlideCount,
          practiceQuestionCount: safePracticeQuestionCount,
          includePracticeTest: false,
          includePresentation: wantsPresentation,
          includeVideoPlan: wantsVideoPlan,
          sourceContext,
        }),
        AI_ROUND_GENERATION_TIMEOUT_MS
      )
      console.info(`[AI] les voor room ${room.code} gegenereerd via ${lessonResult.providerLabel}`)
    } catch (aiError) {
      const fullErrorMessage = aiError instanceof Error ? aiError.message : "AI-fout"
      const userMessage = formatGenerationError(aiError)
      console.error("AI lesgeneratie mislukt:", fullErrorMessage)
      room.questions = []
      room.currentQuestionIndex = -1
      room.answeredPlayers = new Set()
      room.playerAnswers = new Map()
      room.lessonResponses = new Map()
      room.lesson = createEmptyLessonState()
      room.math = createEmptyMathState()
      room.game = {
        ...createIdleGameState(Boolean(room.game?.groupModeEnabled)),
        mode: "lesson",
        topic: String(topic ?? "").trim(),
        audience: audience?.trim() || "vmbo",
        lessonModel: safeLessonModel,
        lessonDurationMinutes: safeDuration,
      }
      emitStateToRoom(room)
      socket.emit("host:error", { message: userMessage })
      return
    }

    let practiceTest = null
    if (wantsPracticeTest) {
      try {
        const practiceResult = await withTimeout(
          generateQuestions({
            topic: `${String(topic ?? "").trim()}\nMaak hier een korte oefentoets van met afwisselende controlevragen.`,
            audience,
            questionCount: safePracticeQuestionCount,
            questionFormat: safePracticeQuestionFormat,
            sourceContext,
          }),
          AI_ROUND_GENERATION_TIMEOUT_MS
        )
        practiceTest = {
          title: `Oefentoets over ${String(topic ?? "").trim() || "dit onderwerp"}`,
          instructions: "Maak deze oefentoets zelfstandig en bespreek daarna de antwoorden.",
          questionFormat: safePracticeQuestionFormat,
          questions: practiceResult.questions,
          providerLabel: practiceResult.providerLabel,
        }
        console.info(`[AI] oefentoets voor room ${room.code} gegenereerd via ${practiceResult.providerLabel}`)
      } catch (practiceError) {
        console.error("AI oefentoetsgeneratie mislukt:", practiceError instanceof Error ? practiceError.message : practiceError)
        if (sourceContext) {
          practiceTest = null
        } else {
          practiceTest = {
            title: `Oefentoets over ${String(topic ?? "").trim() || "dit onderwerp"}`,
            instructions: "Maak deze oefentoets zelfstandig en bespreek daarna de antwoorden.",
            questionFormat: safePracticeQuestionFormat,
            questions: buildFallbackQuestions({
              topic,
              questionCount: safePracticeQuestionCount,
              questionFormat: safePracticeQuestionFormat,
            }).slice(0, safePracticeQuestionCount),
            providerLabel: "Lokale reserve",
          }
        }
      }
    }

    const presentation = wantsPresentation ? lessonResult.lesson.presentation : null

    room.questions = []
    room.currentQuestionIndex = -1
    room.answeredPlayers = new Set()
    room.playerAnswers = new Map()
    room.lessonResponses = new Map()
    room.math = createEmptyMathState()
    room.lesson = {
      ...withLessonPhaseContext(
        {
          ...lessonResult.lesson,
          libraryId: null,
          currentPhaseIndex: 0,
          practiceTest,
          presentation,
          includePracticeTest: Boolean(practiceTest?.questions?.length),
          includePresentation: Boolean(presentation?.slides?.length),
          includeVideoPlan: Boolean(presentation?.video?.scenes?.length),
        },
        0
      ),
    }
    room.game = {
      ...createIdleGameState(Boolean(room.game?.groupModeEnabled)),
      topic: String(topic ?? "").trim(),
      audience: audience?.trim() || "vmbo",
      status: "live",
      source: lessonResult.provider || "ai",
      providerLabel: lessonResult.providerLabel || "AI",
      generatedAt: new Date().toISOString(),
      mode: "lesson",
      lessonModel: safeLessonModel,
      lessonDurationMinutes: safeDuration,
    }

    recordSessionHistory(buildSessionHistoryEntryFromRoom(room, "lesson"))
    emitStateToRoom(room)
    socket.emit("host:generate-lesson:success", {
      count: room.lesson.phases.length,
      provider: lessonResult.provider || null,
      providerLabel: lessonResult.providerLabel || null,
      lessonModel: room.lesson.model,
      hasPracticeTest: Boolean(room.lesson.practiceTest?.questions?.length),
      hasPresentation: Boolean(room.lesson.presentation?.slides?.length),
    })
  })

  socket.on("host:start-practice-test", () => {
    const room = requireHostRoom(socket)
    if (!room) return
    const practiceTest = room.lesson?.practiceTest
    if (!practiceTest?.questions?.length) {
      socket.emit("host:error", { message: "Er is nog geen oefentoets beschikbaar voor deze les." })
      return
    }

    room.questions = practiceTest.questions.map((question, index) => ({
      ...question,
      id: `practice-${index + 1}`,
      prompt: String(question.prompt || question.question_text || "").trim(),
      options: [...(question.options || [])],
      acceptedAnswers: [...(question.acceptedAnswers || [])],
      durationSec: normalizePracticeQuestionFormat(question.questionType) === "typed" ? 35 : 25,
    }))
    room.currentQuestionIndex = 0
    room.answeredPlayers = new Set()
    room.playerAnswers = new Map()
    room.lessonResponses = new Map()
    room.math = createEmptyMathState()
    room.game = {
      ...createIdleGameState(Boolean(room.game?.groupModeEnabled)),
      topic: room.game.topic,
      audience: room.game.audience,
      questionCount: room.questions.length,
      questionDurationSec: 25,
      questionStartedAt: new Date().toISOString(),
      status: "live",
      answerRevealed: false,
      source: "practice",
      providerLabel: "Oefentoets",
      generatedAt: new Date().toISOString(),
      mode: "battle",
    }

    recordSessionHistory(buildSessionHistoryEntryFromRoom(room, "practice"))
    emitStateToRoom(room)
    socket.emit("host:generate:success", {
      count: room.questions.length,
      provider: "practice",
      providerLabel: "Oefentoets",
    })
  })

  socket.on("host:save-lesson", () => {
    const room = requireHostRoom(socket)
    if (!room) return
    if (!room.lesson?.phases?.length) {
      socket.emit("host:error", { message: "Er is nog geen les om op te slaan." })
      return
    }

    const now = new Date().toISOString()
    const entryId = room.lesson.libraryId || generateEntityId("lesson")
    const existing = lessonLibrary.find((entry) => entry.id === entryId)
    const hostSession = getHostSession(socket.id)
    const entry = {
      id: entryId,
      topic: room.game.topic,
      title: room.lesson.title,
      isFavorite: Boolean(existing?.isFavorite),
      sectionName: String(existing?.sectionName || "").trim() || "Algemene sectie",
      ownerUsername: normalizeTeacherUsername(existing?.ownerUsername || hostSession?.username || ""),
      ownerDisplayName: String(existing?.ownerDisplayName || hostSession?.displayName || hostSession?.username || "Docent").trim() || "Docent",
      folderName: String(existing?.folderName || "").trim() || `${String(room.lesson.audience || room.game.audience || "vmbo").toUpperCase()} lessen`,
      tags: Array.isArray(existing?.tags)
        ? existing.tags
        : Array.from(
            new Set(
              [room.game.topic, room.lesson.audience || room.game.audience, room.lesson.model]
                .join(",")
                .split(/[,/]| en | met /i)
                .map((item) => String(item || "").trim())
                .filter(Boolean)
            )
          ).slice(0, 8),
      audience: room.lesson.audience || room.game.audience,
      model: room.lesson.model,
      durationMinutes: room.lesson.durationMinutes,
      lessonGoal: room.lesson.lessonGoal,
      successCriteria: [...(room.lesson.successCriteria || [])],
      materials: [...(room.lesson.materials || [])],
      lesson: cloneLessonForRoom(room.lesson, entryId),
      source: room.game.source || "ai",
      providerLabel: room.game.providerLabel || "AI",
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }

    lessonLibrary = [entry, ...lessonLibrary.filter((item) => item.id !== entryId)]
    persistLessonLibrary()
    room.lesson = cloneLessonForRoom(room.lesson, entryId)
    emitLessonLibraryToHosts()
    socket.emit("host:save-lesson:success", { lessonId: entryId, title: entry.title })
    emitStateToRoom(room)
  })

  socket.on("host:load-lesson", ({ lessonId }) => {
    const room = requireHostRoom(socket)
    if (!room) return

    const entry = lessonLibrary.find((item) => item.id === lessonId)
    if (!entry) {
      socket.emit("host:error", { message: "Deze les staat niet meer in de bibliotheek." })
      return
    }

    room.questions = []
    room.currentQuestionIndex = -1
    room.answeredPlayers = new Set()
    room.playerAnswers = new Map()
    room.lessonResponses = new Map()
    room.math = createEmptyMathState()
    room.lesson = {
      ...withLessonPhaseContext(cloneLessonForRoom(entry.lesson, entry.id), 0),
    }
    room.game = {
      ...createIdleGameState(Boolean(room.game?.groupModeEnabled)),
      topic: entry.topic,
      audience: entry.audience,
      status: "live",
      source: "library",
      providerLabel: "Lesbibliotheek",
      generatedAt: new Date().toISOString(),
      mode: "lesson",
      lessonModel: entry.model,
      lessonDurationMinutes: entry.durationMinutes,
    }

    socket.emit("host:load-lesson:success", { title: entry.title })
    emitStateToRoom(room)
  })

  socket.on("host:lesson-library:favorite", ({ lessonId, isFavorite }) => {
    const room = requireHostRoom(socket)
    if (!room) return

    const targetIndex = lessonLibrary.findIndex((item) => item.id === lessonId)
    if (targetIndex === -1) {
      socket.emit("host:error", { message: "Deze les staat niet meer in de bibliotheek." })
      return
    }

    const currentEntry = lessonLibrary[targetIndex]
    const nextFavorite = typeof isFavorite === "boolean" ? isFavorite : !Boolean(currentEntry.isFavorite)
    lessonLibrary[targetIndex] = {
      ...currentEntry,
      isFavorite: nextFavorite,
      updatedAt: currentEntry.updatedAt,
    }
    persistLessonLibrary()
    emitLessonLibraryToHosts()
    socket.emit("host:lesson-library:favorite:success", {
      lessonId,
      isFavorite: nextFavorite,
      title: currentEntry.title,
    })
  })

  socket.on("host:lesson-library:update-meta", ({ lessonId, folderName, sectionName, tags }) => {
    const room = requireHostRoom(socket)
    if (!room) return

    const targetIndex = lessonLibrary.findIndex((item) => item.id === lessonId)
    if (targetIndex === -1) {
      socket.emit("host:error", { message: "Deze les staat niet meer in de bibliotheek." })
      return
    }

    const currentEntry = lessonLibrary[targetIndex]
    const nextFolderName = String(folderName ?? currentEntry.folderName ?? "").trim() || currentEntry.folderName || "Algemene map"
    const nextSectionName = String(sectionName ?? currentEntry.sectionName ?? "").trim() || currentEntry.sectionName || "Algemene sectie"
    const nextTags = Array.from(
      new Set(
        (Array.isArray(tags) ? tags : String(tags ?? "").split(","))
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      )
    ).slice(0, 8)

    lessonLibrary[targetIndex] = {
      ...currentEntry,
      folderName: nextFolderName,
      sectionName: nextSectionName,
      tags: nextTags,
    }
    persistLessonLibrary()
    emitLessonLibraryToHosts()
    socket.emit("host:lesson-library:update-meta:success", {
      lessonId,
      title: currentEntry.title,
    })
  })

  socket.on("host:lesson-prompt:update", ({ prompt, expectedAnswer }) => {
    const room = requireHostRoom(socket)
    if (!room || room.game.mode !== "lesson") return

    const phase = currentLessonPhase(room)
    if (!phase) return

    room.lesson = {
      ...room.lesson,
      activePrompt: String(prompt ?? "").trim() || phase.interactivePrompt,
      activeExpectedAnswer: String(expectedAnswer ?? "").trim() || phase.expectedAnswer || "",
      activeKeywords: uniqueTokens([
        ...(phase.keywords || []),
        String(expectedAnswer ?? "").trim() || phase.expectedAnswer || "",
      ]),
      promptVersion: Date.now(),
    }
    room.lessonResponses = new Map()
    emitStateToRoom(room)
    emitLessonPromptUpdate(room)
    socket.emit("host:lesson-prompt:success", { prompt: room.lesson.activePrompt })
  })

  socket.on("host:presentation-image:update", async ({ slideId, imageUrl, imageAlt, uploadDataUrl }) => {
    const room = requireHostRoom(socket)
    if (!room || room.game.mode !== "lesson" || !room.lesson?.presentation?.slides?.length) return
    try {
      const payload = await updatePresentationSlideManualImage({
        room,
        slideId,
        imageUrl,
        imageAlt,
        uploadDataUrl,
      })
      socket.emit("host:presentation-image:success", payload)
    } catch (error) {
      socket.emit("host:error", {
        message: error instanceof Error ? error.message : "De afbeelding kon niet worden opgeslagen.",
      })
    }
  })

  socket.on("host:presentation-image:auto", async ({ slideId }) => {
    const room = requireHostRoom(socket)
    if (!room || room.game.mode !== "lesson" || !room.lesson?.presentation?.slides?.length) return

    const normalizedSlideId = String(slideId ?? "").trim()
    if (!normalizedSlideId) {
      socket.emit("host:error", { message: "Kies eerst een dia voordat je automatisch laat zoeken." })
      return
    }

    const targetSlide = room.lesson.presentation.slides.find((slide) => slide.id === normalizedSlideId) || null
    if (!targetSlide) {
      socket.emit("host:error", { message: "Deze dia bestaat niet meer in de huidige presentatie." })
      return
    }

    const previousManualImageUrl = sanitizeManualImageUrl(targetSlide.manualImageUrl || "")
    const genericSlideTitles = new Set(["conclusie", "summary", "samenvatting", "slot", "afsluiting", "intro", "introduction", "inleiding"])
    const normalizedSlideTitle = String(targetSlide.title || "").trim().toLowerCase()
    const searchPrompt = [
      room.lesson?.title,
      targetSlide.imageAlt,
      targetSlide.imagePrompt,
      targetSlide.focus,
      targetSlide.studentViewText,
      ...(targetSlide.bullets || []),
      genericSlideTitles.has(normalizedSlideTitle) ? "" : targetSlide.title,
    ]
      .filter(Boolean)
      .join(" ")
      .trim()
    const searchCategory = [
      room.game.topic || "",
      room.lesson?.title || "",
      genericSlideTitles.has(normalizedSlideTitle) ? "" : targetSlide.title,
      targetSlide.imageAlt || "",
    ]
      .filter(Boolean)
      .join(" ")
      .trim()
    const excludedSources = [
      ...(Array.isArray(targetSlide.manualImageSourceHistory) ? targetSlide.manualImageSourceHistory : []),
      targetSlide.manualImageSourceUrl,
      targetSlide.manualImageUrl,
      targetSlide.manualImageSourceImageUrl,
      targetSlide.manualImageSourceTitle,
    ].filter(Boolean)
    const searchAttempt = Math.max(1, (Number(targetSlide.manualImageSearchAttempt) || 0) + 1)

    room.lesson = {
      ...room.lesson,
      presentation: {
        ...room.lesson.presentation,
        slides: room.lesson.presentation.slides.map((slide) =>
          slide.id === normalizedSlideId
            ? {
                ...slide,
                manualImageSearchAttempt: searchAttempt,
              }
            : slide
        ),
      },
    }

    let referenceImage = null
    try {
      referenceImage = await searchReusableReferenceImage({
        prompt: searchPrompt,
        category: searchCategory,
        kind: "slide",
        exclude: excludedSources,
        attemptIndex: searchAttempt - 1,
      })
    } catch (error) {
      socket.emit("host:error", {
        message: error instanceof Error ? error.message : "Zoeken naar een online dia-afbeelding is mislukt.",
      })
      return
    }

    if (!referenceImage?.buffer) {
      socket.emit("host:error", {
        message: previousManualImageUrl
          ? "Er is geen beter passend alternatief gevonden dan de huidige dia-afbeelding. Pas de dia-tekst aan of upload handmatig."
          : "Er is geen passende rechtenvrije internetafbeelding gevonden voor deze dia. Probeer een andere dia of upload handmatig.",
      })
      return
    }

    let nextManualImageUrl = ""
    try {
      nextManualImageUrl = saveManualImageFromBuffer({
        imageBuffer: referenceImage.buffer,
        mimeType: referenceImage.contentType,
        entityId: normalizedSlideId,
      })
    } catch (error) {
      socket.emit("host:error", {
        message: error instanceof Error ? error.message : "De gevonden dia-afbeelding kon niet worden opgeslagen.",
      })
      return
    }

    room.lesson = {
      ...room.lesson,
      presentation: {
        ...room.lesson.presentation,
        slides: room.lesson.presentation.slides.map((slide) =>
          slide.id === normalizedSlideId
            ? {
                ...slide,
                manualImageUrl: nextManualImageUrl,
                imageAlt: slide.imageAlt || slide.title || "Presentatiedia",
                manualImageSourceUrl: referenceImage.sourceUrl || "",
                manualImageSourceImageUrl: referenceImage.originalImageUrl || referenceImage.imageUrl || "",
                manualImageSearchQuery: referenceImage.searchQuery || "",
                manualImageSourceTitle: referenceImage.title || "",
                manualImageSearchAttempt: searchAttempt,
                manualImageSourceHistory: sanitizeImageSourceHistory([
                  ...(Array.isArray(slide.manualImageSourceHistory) ? slide.manualImageSourceHistory : []),
                  referenceImage.sourceUrl,
                  referenceImage.originalImageUrl,
                  referenceImage.imageUrl,
                  referenceImage.title,
                ]),
              }
            : slide
        ),
      },
    }

    if (previousManualImageUrl && previousManualImageUrl !== nextManualImageUrl) {
      removeManualImageFileIfUnused(previousManualImageUrl)
    }

    emitStateToRoom(room)
    socket.emit("host:presentation-image:success", {
      slideId: normalizedSlideId,
      manualImageUrl: nextManualImageUrl,
      imageAlt: targetSlide.imageAlt || targetSlide.title || "Presentatiedia",
      sourceTitle: referenceImage.title || "",
      sourceUrl: referenceImage.sourceUrl || "",
      searchQuery: referenceImage.searchQuery || "",
      searchAttempt,
    })
  })

  socket.on("host:presentation-image:clear", ({ slideId }) => {
    const room = requireHostRoom(socket)
    if (!room || room.game.mode !== "lesson" || !room.lesson?.presentation?.slides?.length) return

    const normalizedSlideId = String(slideId ?? "").trim()
    if (!normalizedSlideId) {
      socket.emit("host:error", { message: "Kies eerst een dia voordat je de afbeelding wist." })
      return
    }

    const previousSlide = room.lesson.presentation.slides.find((slide) => slide.id === normalizedSlideId) || null
    const previousManualImageUrl = sanitizeManualImageUrl(previousSlide?.manualImageUrl || "")

    room.lesson = {
      ...room.lesson,
      presentation: {
        ...room.lesson.presentation,
        slides: room.lesson.presentation.slides.map((slide) =>
          slide.id === normalizedSlideId
            ? {
                ...slide,
                manualImageUrl: "",
                manualImageSourceUrl: "",
                manualImageSourceImageUrl: "",
                manualImageSearchQuery: "",
                manualImageSourceTitle: "",
                manualImageSearchAttempt: 0,
                manualImageSourceHistory: sanitizeImageSourceHistory(slide.manualImageSourceHistory || []),
              }
            : slide
        ),
      },
    }

    if (previousManualImageUrl) {
      removeManualImageFileIfUnused(previousManualImageUrl)
    }

    emitStateToRoom(room)
    socket.emit("host:presentation-image:success", {
      slideId: normalizedSlideId,
      manualImageUrl: "",
      imageAlt: previousSlide?.imageAlt || previousSlide?.title || "Presentatiedia",
    })
  })

  socket.on("host:question-image:update", async ({ imageUrl, imageAlt, uploadDataUrl }) => {
    const room = requireHostRoom(socket)
    if (!room || !currentQuestion(room)) return
    try {
      const payload = await updateCurrentQuestionManualImage({
        room,
        imageUrl,
        imageAlt,
        uploadDataUrl,
      })
      socket.emit("host:question-image:success", payload)
    } catch (error) {
      socket.emit("host:error", {
        message: error instanceof Error ? error.message : "De vraagafbeelding kon niet worden opgeslagen.",
      })
    }
  })

  socket.on("host:question-image:auto", async () => {
    const room = requireHostRoom(socket)
    const activeQuestion = currentQuestion(room)
    if (!room || !activeQuestion) return

    const previousManualImageUrl = sanitizeManualImageUrl(activeQuestion.manualImageUrl || "")
    const excludedSources = [
      ...(Array.isArray(activeQuestion.manualImageSourceHistory) ? activeQuestion.manualImageSourceHistory : []),
      activeQuestion.manualImageSourceUrl,
      activeQuestion.manualImageUrl,
      activeQuestion.manualImageSourceImageUrl,
      activeQuestion.manualImageSourceTitle,
    ].filter(Boolean)
    const searchAttempt = Math.max(1, (Number(activeQuestion.manualImageSearchAttempt) || 0) + 1)

    room.questions = room.questions.map((question, index) =>
      index === room.currentQuestionIndex
        ? {
            ...question,
            manualImageSearchAttempt: searchAttempt,
          }
        : question
    )

    let referenceImage = null
    try {
      referenceImage = await searchReusableReferenceImage({
        prompt: buildQuestionSearchPrompt(activeQuestion, room),
        category: buildQuestionSearchCategory(activeQuestion, room),
        kind: "question",
        exclude: excludedSources,
        attemptIndex: searchAttempt - 1,
      })
    } catch (error) {
      socket.emit("host:error", {
        message: error instanceof Error ? error.message : "Zoeken naar een online vraagafbeelding is mislukt.",
      })
      return
    }

    if (!referenceImage?.buffer) {
      socket.emit("host:error", {
        message: previousManualImageUrl
          ? "Er is geen beter passend alternatief gevonden dan de huidige vraagafbeelding. Pas de vraagtekst aan of upload handmatig."
          : "Er is geen passende rechtenvrije internetafbeelding gevonden voor deze vraag. Probeer een andere vraag of upload handmatig.",
      })
      return
    }

    let nextManualImageUrl = ""
    try {
      nextManualImageUrl = saveManualImageFromBuffer({
        imageBuffer: referenceImage.buffer,
        mimeType: referenceImage.contentType,
        entityId: activeQuestion.id || `question-${room.currentQuestionIndex + 1}`,
      })
    } catch (error) {
      socket.emit("host:error", {
        message: error instanceof Error ? error.message : "De gevonden vraagafbeelding kon niet worden opgeslagen.",
      })
      return
    }

    room.questions = room.questions.map((question, index) =>
      index === room.currentQuestionIndex
        ? {
            ...question,
            manualImageUrl: nextManualImageUrl,
            imageAlt: question.imageAlt || question.prompt || "Vraagafbeelding",
            manualImageSourceUrl: referenceImage.sourceUrl || "",
            manualImageSourceImageUrl: referenceImage.originalImageUrl || referenceImage.imageUrl || "",
            manualImageSearchQuery: referenceImage.searchQuery || "",
            manualImageSourceTitle: referenceImage.title || "",
            manualImageSearchAttempt: searchAttempt,
            manualImageSourceHistory: sanitizeImageSourceHistory([
              ...(Array.isArray(question.manualImageSourceHistory) ? question.manualImageSourceHistory : []),
              referenceImage.sourceUrl,
              referenceImage.originalImageUrl,
              referenceImage.imageUrl,
              referenceImage.title,
            ]),
          }
        : question
    )

    if (previousManualImageUrl && previousManualImageUrl !== nextManualImageUrl) {
      removeManualImageFileIfUnused(previousManualImageUrl)
    }

    emitStateToRoom(room)
    socket.emit("host:question-image:success", {
      questionId: activeQuestion.id,
      manualImageUrl: nextManualImageUrl,
      imageAlt: activeQuestion.imageAlt || activeQuestion.prompt || "Vraagafbeelding",
      sourceTitle: referenceImage.title || "",
      sourceUrl: referenceImage.sourceUrl || "",
      searchQuery: referenceImage.searchQuery || "",
      searchAttempt,
    })
  })

  socket.on("host:question-image:clear", () => {
    const room = requireHostRoom(socket)
    const activeQuestion = currentQuestion(room)
    if (!room || !activeQuestion) return

    const previousManualImageUrl = sanitizeManualImageUrl(activeQuestion.manualImageUrl || "")
    room.questions = room.questions.map((question, index) =>
      index === room.currentQuestionIndex
        ? {
            ...question,
            manualImageUrl: "",
            manualImageSourceUrl: "",
            manualImageSourceImageUrl: "",
            manualImageSearchQuery: "",
            manualImageSourceTitle: "",
            manualImageSearchAttempt: 0,
            manualImageSourceHistory: sanitizeImageSourceHistory(question.manualImageSourceHistory || []),
          }
        : question
    )

    if (previousManualImageUrl) {
      removeManualImageFileIfUnused(previousManualImageUrl)
    }

    emitStateToRoom(room)
    socket.emit("host:question-image:success", {
      questionId: activeQuestion.id,
      manualImageUrl: "",
      imageAlt: activeQuestion.imageAlt || activeQuestion.prompt || "Vraagafbeelding",
    })
  })

  socket.on("host:delete-lesson", ({ lessonId }) => {
    const room = requireHostRoom(socket)
    if (!room) return

    const exists = lessonLibrary.some((item) => item.id === lessonId)
    if (!exists) return

    lessonLibrary = lessonLibrary.filter((item) => item.id !== lessonId)
    persistLessonLibrary()

    if (room.lesson?.libraryId === lessonId) {
      room.lesson = { ...room.lesson, libraryId: null }
      emitStateToRoom(room)
    }

    emitLessonLibraryToHosts()
    socket.emit("host:delete-lesson:success", { lessonId })
  })

  socket.on("host:history:load", ({ entryId }) => {
    const room = requireHostRoom(socket)
    if (!room) return

    const entry = sessionHistory.find((item) => item.id === entryId)
    if (!entry) {
      socket.emit("host:error", { message: "Deze geschiedenis-entry bestaat niet meer." })
      return
    }

    room.answeredPlayers = new Set()
    room.playerAnswers = new Map()
    room.lessonResponses = new Map()
    room.math = createEmptyMathState()

    if (entry.type === "lesson" && entry.lesson) {
      room.questions = []
      room.currentQuestionIndex = -1
      room.lesson = {
        ...withLessonPhaseContext(cloneLessonForRoom(entry.lesson, entry.lesson?.libraryId || null), 0),
      }
      room.game = {
        ...createIdleGameState(Boolean(room.game?.groupModeEnabled)),
        topic: entry.topic,
        audience: entry.audience,
        status: "live",
        source: "history",
        providerLabel: entry.providerLabel || "Geschiedenis",
        generatedAt: new Date().toISOString(),
        mode: "lesson",
        lessonModel: entry.model || room.lesson.model,
        lessonDurationMinutes: entry.durationMinutes || room.lesson.durationMinutes || 45,
      }
    } else {
      room.questions = cloneQuestionsForStorage(entry.questions)
      room.lesson = createEmptyLessonState()
      room.math = createEmptyMathState()

      if (entry.type === "practice") {
        room.currentQuestionIndex = room.questions.length ? 0 : -1
        room.game = {
          ...createIdleGameState(Boolean(room.game?.groupModeEnabled)),
          topic: entry.topic,
          audience: entry.audience,
          questionCount: room.questions.length,
          questionDurationSec: Number(room.questions[0]?.durationSec) || 25,
          questionStartedAt: room.questions.length ? new Date().toISOString() : null,
          status: room.questions.length ? "live" : "idle",
          answerRevealed: false,
          source: "practice",
          providerLabel: entry.providerLabel || "Geschiedenis",
          generatedAt: new Date().toISOString(),
          mode: "battle",
        }
      } else {
        room.game = {
          ...createIdleGameState(Boolean(room.game?.groupModeEnabled)),
          topic: entry.topic,
          audience: entry.audience,
          questionCount: room.questions.length,
          questionDurationSec: Number(room.questions[0]?.durationSec) || 20,
          questionStartedAt: null,
          status: room.questions.length ? "preview" : "idle",
          answerRevealed: false,
          source: "history",
          providerLabel: entry.providerLabel || "Geschiedenis",
          generatedAt: new Date().toISOString(),
          mode: "battle",
        }
        setCurrentQuestionPreview(room, room.questions.length ? 0 : -1)
      }
    }

    emitStateToRoom(room)
    socket.emit("host:history:load:success", {
      entryId: entry.id,
      title: entry.title,
      type: entry.type,
    })
  })

  socket.on("host:history:delete", ({ entryId }) => {
    const room = requireHostRoom(socket)
    if (!room) return

    const exists = sessionHistory.some((entry) => entry.id === entryId)
    if (!exists) return

    sessionHistory = sessionHistory.filter((entry) => entry.id !== entryId)
    persistSessionHistory()
    emitSessionHistoryToHosts()
    socket.emit("host:history:delete:success", { entryId })
  })

  socket.on("host:next", () => {
    const room = requireHostRoom(socket)
    if (!room) return

    if (room.currentQuestionIndex + 1 >= room.questions.length) {
      setCurrentQuestionPreview(room, -1)
      room.answeredPlayers = new Set()
      room.playerAnswers = new Map()
      room.game = {
        ...room.game,
        status: room.questions.length ? "finished" : "idle",
        questionStartedAt: null,
        answerRevealed: false,
      }
      emitStateToRoom(room)
      return
    }

    if (room.game.source === "practice") {
      room.currentQuestionIndex += 1
      room.answeredPlayers = new Set()
      room.playerAnswers = new Map()
      stampQuestionStart(room)
      emitStateToRoom(room)
      return
    }

    setCurrentQuestionPreview(room, room.currentQuestionIndex + 1)
    room.answeredPlayers = new Set()
    room.playerAnswers = new Map()
    emitStateToRoom(room)
  })

  socket.on("host:start-question", ({ durationSec }) => {
    const room = requireHostRoom(socket)
    if (!room || room.game.mode !== "battle" || room.game.source === "practice") return

    const question = currentQuestion(room)
    if (!question) {
      socket.emit("host:error", { message: "Er staat nog geen vraag klaar in preview." })
      return
    }

    const safeDuration = Math.max(5, Math.min(180, Number(durationSec) || Number(question.durationSec) || 20))
    question.durationSec = safeDuration
    room.game = {
      ...room.game,
      questionDurationSec: safeDuration,
      status: "preview",
      answerRevealed: false,
    }
    room.answeredPlayers = new Set()
    room.playerAnswers = new Map()
    stampQuestionStart(room)
    emitStateToRoom(room)
  })

  socket.on("host:show-answer", () => {
    const room = requireHostRoom(socket)
    if (!room || room.game.mode !== "battle" || room.game.source === "practice") return
    const question = currentQuestion(room)
    if (!question) return
    if (!canRevealBattleAnswer(room, question)) {
      socket.emit("host:error", {
        message: "Wacht tot iedereen geantwoord heeft of tot de tijd voorbij is voordat je het juiste antwoord toont.",
      })
      return
    }

    room.game = {
      ...room.game,
      status: "revealed",
      questionStartedAt: null,
      answerRevealed: true,
    }
    emitStateToRoom(room)
    emitBattleRevealResults(room, question)
  })

  socket.on("player:practice-next", () => {
    const room = getRoomBySocketId(socket.id)
    if (!room || room.game.source !== "practice" || room.game.mode !== "battle") return
    const player = getPlayerBySocketId(room, socket.id)
    if (!player) return

    const question = currentQuestion(room)
    if (!question) return

    const startTime = room.game.questionStartedAt ? new Date(room.game.questionStartedAt).getTime() : 0
    const currentDuration = Number(question.durationSec) || room.game.questionDurationSec
    const answerWindowEnded = !startTime || Date.now() > startTime + currentDuration * 1000
    const alreadyAnswered = room.answeredPlayers.has(player.id)

    if (!alreadyAnswered && !answerWindowEnded) {
      socket.emit("player:error", { message: "Beantwoord eerst de vraag of wacht tot de tijd voorbij is." })
      return
    }

    if (room.currentQuestionIndex + 1 >= room.questions.length) {
      room.currentQuestionIndex = -1
      room.answeredPlayers = new Set()
      room.playerAnswers = new Map()
      room.game = {
        ...room.game,
        status: room.questions.length ? "finished" : "idle",
        questionStartedAt: null,
        answerRevealed: false,
      }
      emitStateToRoom(room)
      return
    }

    room.currentQuestionIndex += 1
    room.answeredPlayers = new Set()
    room.playerAnswers = new Map()
    stampQuestionStart(room)
    emitStateToRoom(room)
  })

  socket.on("host:lesson-next", () => {
    const room = requireHostRoom(socket)
    if (!room) return

    if (!room.lesson?.phases?.length) return

    if (room.lesson.currentPhaseIndex + 1 >= room.lesson.phases.length) {
      room.lesson = { ...room.lesson, currentPhaseIndex: -1 }
      room.lessonResponses = new Map()
      room.game = { ...room.game, status: "finished", questionStartedAt: null }
      emitStateToRoom(room)
      return
    }

    room.lesson = withLessonPhaseContext(room.lesson, room.lesson.currentPhaseIndex + 1)
    room.lessonResponses = new Map()
    room.game = { ...room.game, status: "live", questionStartedAt: null }
    emitStateToRoom(room)
  })

  socket.on("host:lesson-prev", () => {
    const room = requireHostRoom(socket)
    if (!room) return

    if (!room.lesson?.phases?.length) return

    const lastPhaseIndex = Math.max(0, room.lesson.phases.length - 1)
    const currentPhaseIndex = Number.isInteger(room.lesson.currentPhaseIndex) ? room.lesson.currentPhaseIndex : -1
    const targetPhaseIndex =
      currentPhaseIndex < 0
        ? lastPhaseIndex
        : Math.max(0, currentPhaseIndex - 1)

    room.lesson = withLessonPhaseContext(room.lesson, targetPhaseIndex)
    room.lessonResponses = new Map()
    room.game = { ...room.game, status: "live", questionStartedAt: null }
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
    room.lessonResponses = new Map()
    room.lesson = createEmptyLessonState()
    room.math = createEmptyMathState()
    room.game = createIdleGameState(Boolean(room.game?.groupModeEnabled))
    emitStateToRoom(room)
  })

  socket.on("host:remove-player", async ({ playerId }) => {
    const room = requireHostRoom(socket)
    if (!room) return

    const playerToRemove = room.players.find((player) => player.id === playerId)
    if (!playerToRemove) return

    room.players = room.players.filter((player) => player.id !== playerId)
    room.answeredPlayers.delete(playerId)
    room.playerAnswers.delete(playerId)
    room.lessonResponses.delete(playerId)
    room.math?.playerProgress?.delete(playerId)
    if (playerToRemove.socketId) socketToRoom.delete(playerToRemove.socketId)

    if (playerToRemove.socketId) {
      io.to(playerToRemove.socketId).emit("player:removed", {
        message: "Je bent verwijderd door de beheerder. Je kunt opnieuw deelnemen met de sessiecode.",
      })
    }

    await removeMathResumeIndex(playerToRemove.name, playerToRemove.learnerCode)
    emitStateToRoom(room)
  })

  socket.on("host:math:learner:create", async ({ name, learnerCode }) => {
    const room = requireHostRoom(socket)
    if (!room || room.game.mode !== "math") return
    if (room.math?.classId) {
      socket.emit("host:error", { message: "Deze rekenroute gebruikt al een vaste klas. Voeg leerlingen toe via Beheer > Klassen." })
      return
    }

    const trimmedName = String(name ?? "").trim()
    const normalizedCode = normalizeLearnerCode(learnerCode) || generateUniqueLearnerCode(room)
    if (!trimmedName) {
      socket.emit("host:error", { message: "Geef eerst de naam van de leerling op." })
      return
    }
    if (!isValidLearnerCode(normalizedCode)) {
      socket.emit("host:error", { message: "Gebruik een leerlingcode van precies 4 cijfers." })
      return
    }
    if (room.players.some((player) => player.learnerCode === normalizedCode)) {
      socket.emit("host:error", { message: "Deze leerlingcode is al in gebruik." })
      return
    }

    const nextPlayer = createPlayerRecord({
      learnerCode: normalizedCode,
      name: trimmedName,
      teamId: room.teams[0]?.id || "team-1",
      connected: false,
      score: 0,
    })
    room.players.push(nextPlayer)
    ensureMathProgress(room, nextPlayer.id)
    await ensureMathGrowthRecordLoaded(nextPlayer.name || "", nextPlayer.learnerCode || "")
    emitStateToRoom(room)
    await syncMathResumeIndexForPlayer(room, nextPlayer)
    socket.emit("host:learner-code:success", {
      message: `Leerling ${trimmedName} toegevoegd met code ${normalizedCode}.`,
    })
  })

  socket.on("host:learner-code:update", async ({ playerId, learnerCode }) => {
    const room = requireHostRoom(socket)
    if (!room) return

    const player = room.players.find((entry) => entry.id === String(playerId ?? "").trim())
    if (!player) {
      socket.emit("host:error", { message: "Deze leerling staat niet meer in de room." })
      return
    }

    const normalizedCode = normalizeLearnerCode(learnerCode)
    if (!isValidLearnerCode(normalizedCode)) {
      socket.emit("host:error", { message: "Gebruik een leerlingcode van precies 4 cijfers." })
      return
    }
    if (room.players.some((entry) => entry.id !== player.id && entry.learnerCode === normalizedCode)) {
      socket.emit("host:error", { message: "Deze leercode is al in gebruik binnen deze room." })
      return
    }

    const previousName = player.name
    const previousLearnerCode = player.learnerCode
    player.learnerCode = normalizedCode
    if (player.classId && player.classLearnerId) {
      const linkedClassroom = findClassroomById(player.classId)
      const linkedLearner = linkedClassroom?.learners.find((entry) => entry.id === player.classLearnerId) || null
      if (linkedClassroom && linkedLearner) {
        updateClassroomInMemory(linkedClassroom.id, (entry) => ({
          ...entry,
          learners: entry.learners.map((learnerEntry) =>
            learnerEntry.id === linkedLearner.id
              ? {
                  ...learnerEntry,
                  learnerCode: normalizedCode,
                  updatedAt: new Date().toISOString(),
                }
              : learnerEntry
          ),
          updatedAt: new Date().toISOString(),
        }))
      }
    }
    if (room.game.mode === "math") {
      await renameMathGrowthRecord(previousName, previousLearnerCode, player.name, player.learnerCode)
      const progress = ensureMathProgress(room, player.id)
      if (progress) {
        syncMathGrowthForPlayer(room, player, progress)
      }
    }
    if (player.socketId) {
      io.to(player.socketId).emit("player:profile:update", {
        playerId: player.id,
        learnerCode: player.learnerCode,
      })
    }

    emitStateToRoom(room)
    await removeMathResumeIndex(previousName, previousLearnerCode)
    await syncMathResumeIndexForPlayer(room, player)
    socket.emit("host:learner-code:success", {
      message: `Leercode van ${player.name} is bijgewerkt.`,
    })
  })

  socket.on("player:join", async ({ name, teamId, roomCode, playerSessionId, learnerCode }) => {
    const requestedPlayerSessionId = String(playerSessionId ?? "").trim()
    const requestedLearnerCode = normalizeLearnerCode(learnerCode)
    const requestedTeamId = String(teamId ?? "").trim()
    const normalizedRoomCode = String(roomCode ?? "").trim().toUpperCase()
    let room = rooms.get(normalizedRoomCode)
    if (!room && normalizedRoomCode) {
      room = await restoreMathRoomFromCloud(normalizedRoomCode)
    }
    if (!room) {
      socket.emit("player:error", { message: "De sessiecode klopt niet." })
      return
    }

    const trimmedName = String(name ?? "").trim()
    const isMathRoom = room.game.mode === "math"
    const selectedTeamId = isMathRoom
      ? room.teams[0]?.id || ""
      : room.game.groupModeEnabled && room.teams.some((team) => team.id === requestedTeamId)
        ? requestedTeamId
        : ""
    if (!trimmedName && !isMathRoom) {
      socket.emit("player:error", { message: "Vul eerst een naam in." })
      return
    }
    if (isMathRoom && !selectedTeamId) {
      socket.emit("player:error", { message: "De rekenroom is nog niet klaar. Laat de docent de route opnieuw starten." })
      return
    }
    if (isMathRoom && !isValidLearnerCode(requestedLearnerCode)) {
      socket.emit("player:error", { message: "Vul de leerlingcode van 4 cijfers in die je van de docent hebt gekregen." })
      return
    }

    detachPlayerSocketFromOtherRoom(socket.id, room.code)
    socketToRoom.set(socket.id, room.code)
    const existingPlayer = isMathRoom
      ? room.players.find((player) => player.learnerCode === requestedLearnerCode) ?? null
      : room.players.find((player) => player.id === requestedPlayerSessionId) ??
        room.players.find((player) => player.socketId === socket.id) ??
        null

    if (isMathRoom && !existingPlayer) {
      socket.emit("player:error", { message: "Deze leerlingcode klopt niet of is nog niet door de docent klaargezet." })
      return
    }

    if (existingPlayer) {
      existingPlayer.socketId = socket.id
      existingPlayer.name = isMathRoom && existingPlayer.name ? existingPlayer.name : trimmedName
      existingPlayer.teamId = selectedTeamId
      existingPlayer.learnerCode =
        isMathRoom
          ? requestedLearnerCode
          : existingPlayer.learnerCode || requestedPlayerSessionId || existingPlayer.id
      existingPlayer.connected = true
    } else {
      const nextPlayerId = requestedPlayerSessionId || generateEntityId("player")
      room.players.push(
        createPlayerRecord({
          id: nextPlayerId,
          learnerCode: requestedLearnerCode || generateEntityId("learner"),
          socketId: socket.id,
          name: trimmedName,
          teamId: selectedTeamId,
          score: 0,
          connected: true,
        })
      )
    }

    const joinedPlayer = isMathRoom
      ? room.players.find((player) => player.learnerCode === requestedLearnerCode) ??
        room.players.find((player) => player.socketId === socket.id) ??
        null
      : room.players.find((player) => player.id === requestedPlayerSessionId) ??
        room.players.find((player) => player.socketId === socket.id) ??
        null
    if (isMathRoom && joinedPlayer) {
      await ensureMathGrowthRecordLoaded(joinedPlayer.name || trimmedName, joinedPlayer.learnerCode || requestedLearnerCode)
    }
    socket.emit("player:joined", {
      playerId: joinedPlayer?.id ?? "",
      playerSessionId: isMathRoom ? requestedPlayerSessionId : joinedPlayer?.id ?? requestedPlayerSessionId,
      learnerCode: joinedPlayer?.learnerCode ?? requestedLearnerCode,
      teamId: selectedTeamId,
      roomCode: room.code,
      mode: room.game.mode || "battle",
    })
    emitStateToSocket(socket, room)
    emitStateToRoom(room)
    if (isMathRoom && joinedPlayer) {
      await syncMathResumeIndexForPlayer(room, joinedPlayer)
    }

    const storedAnswer = room.playerAnswers.get(joinedPlayer?.id ?? "")
    if (storedAnswer) {
      const activeQuestion = currentQuestion(room)
      if (room.game.source === "practice" && activeQuestion) {
        socket.emit(
          "player:answer:result",
          buildPlayerAnswerResultPayload(room, joinedPlayer, storedAnswer, activeQuestion)
        )
      } else {
        socket.emit(
          "player:answer:result",
          room.game.status === "live"
            ? {
                answerIndex: storedAnswer.answerIndex,
                waitingForReveal: true,
                playerScore: joinedPlayer?.score ?? 0,
                teamScore: room.teams.find((team) => team.id === selectedTeamId)?.score ?? 0,
              }
            : buildPlayerAnswerResultPayload(room, joinedPlayer, storedAnswer, activeQuestion)
        )
      }
    }

    const storedLessonResponse = room.lessonResponses.get(joinedPlayer?.id ?? "")
    if (storedLessonResponse) {
      socket.emit("player:lesson-response:result", {
        isCorrect: storedLessonResponse.isCorrect,
        label: storedLessonResponse.label,
        feedback: storedLessonResponse.feedback,
      })
    }
  })

  socket.on("player:resume-math", async ({ name, learnerCode, playerSessionId }) => {
    const trimmedName = String(name ?? "").trim()
    const requestedLearnerCode = normalizeLearnerCode(learnerCode)
    const requestedPlayerSessionId = String(playerSessionId ?? "").trim()

    if (!trimmedName) {
      socket.emit("player:error", { message: "Vul eerst je naam in." })
      return
    }

    if (!isValidLearnerCode(requestedLearnerCode)) {
      socket.emit("player:error", { message: "Vul je leerlingcode van 4 cijfers in." })
      return
    }

    let match = findMathRoomForHomeResume(trimmedName, requestedLearnerCode)
    if (match.ambiguous) {
      socket.emit("player:error", {
        message: "Deze naam en leerlingcode horen bij meer dan een rekenroute. Vraag dan toch even de sessiecode aan je docent.",
      })
      return
    }

    if (!match.room || !match.player) {
      match = await findMathRoomForHomeResumeFromCloud(trimmedName, requestedLearnerCode)
      if (!match.room || !match.player) {
        socket.emit("player:error", {
          message: "We vonden geen actieve rekenroute bij deze naam en leerlingcode. Controleer je gegevens of vraag je docent om hulp.",
        })
        return
      }
    }

    const room = match.room
    const player = match.player
    await ensureMathGrowthRecordLoaded(player.name || trimmedName, player.learnerCode || requestedLearnerCode)

    detachPlayerSocketFromOtherRoom(socket.id, room.code)
    socketToRoom.set(socket.id, room.code)
    player.socketId = socket.id
    player.connected = true
    if (!player.name) {
      player.name = trimmedName
    }
    if (!room.game.groupModeEnabled) {
      player.teamId = ""
    }

    socket.emit("player:joined", {
      playerId: player.id,
      playerSessionId: player.id || requestedPlayerSessionId,
      learnerCode: player.learnerCode ?? requestedLearnerCode,
      teamId: player.teamId || "",
      roomCode: room.code,
      mode: room.game.mode || "math",
    })
    emitStateToSocket(socket, room)
    emitStateToRoom(room)
    await syncMathResumeIndexForPlayer(room, player)
  })

  socket.on("player:portal:login", async ({ name, learnerCode }) => {
    await ensureClassroomsHydratedFromCloud()
    const profile = resolveLearnerPortalProfile(name, learnerCode)
    if (!profile) {
      socket.emit("player:error", {
        message: "We herkennen deze naam en leerlingcode nog niet. Vraag je docent om je eerst aan een klas toe te voegen.",
      })
      return
    }

    socket.emit("player:portal:ready", profile)
  })

  socket.on("player:self-practice:start", async ({ name, learnerCode, topic, questionCount, questionFormat, attachments }) => {
    await ensureClassroomsHydratedFromCloud()
    const profile = resolveLearnerPortalProfile(name, learnerCode)
    if (!profile) {
      socket.emit("player:error", {
        message: "We herkennen deze naam en leerlingcode nog niet. Vraag je docent om je eerst aan een klas toe te voegen.",
      })
      return
    }

    const trimmedTopic = String(topic ?? "").trim()
    if (trimmedTopic.length < 2) {
      socket.emit("player:error", { message: "Kies eerst een onderwerp voor je oefentoets." })
      return
    }

    const safeQuestionCount = Math.max(6, Math.min(24, Number(questionCount) || 8))
    const safeQuestionFormat = normalizePracticeQuestionFormat(questionFormat)
    const sessionId = generateEntityId("self-practice")
    const topicLabel = cleanSelfPracticeTopicLabel(trimmedTopic)
    const startedAt = new Date().toISOString()
    let sourceContext = ""

    try {
      sourceContext = await buildAiAttachmentContext(attachments)
    } catch (error) {
      socket.emit("player:error", {
        message: error instanceof Error ? error.message : "De bijlagen konden niet worden gelezen.",
      })
      return
    }

    try {
      const practiceResult = await withTimeout(
        generateQuestions({
          topic: `${trimmedTopic}\nMaak hier een zelfstandige oefentoets van voor een leerling.`,
          audience: profile.audience || "vmbo",
          questionCount: safeQuestionCount,
          questionFormat: safeQuestionFormat,
          sourceContext,
        }),
        AI_ROUND_GENERATION_TIMEOUT_MS
      )

      upsertSelfPracticeSession(profile, {
        sessionId,
        title: `Oefentoets over ${topicLabel}`,
        topic: trimmedTopic,
        topicLabel,
        questionFormat: safeQuestionFormat,
        providerLabel: practiceResult.providerLabel || "AI",
        questionTotal: practiceResult.questions.length,
        answeredCount: 0,
        correctCount: 0,
        status: "active",
        startedAt,
        updatedAt: startedAt,
        finishedAt: "",
        recentAnswers: [],
      })
      socket.emit("player:self-practice:started", {
        sessionId,
        title: `Oefentoets over ${topicLabel}`,
        instructions: "Werk zelfstandig, kijk na elke vraag naar de uitleg en ga daarna verder.",
        topic: trimmedTopic,
        topicLabel,
        questionFormat: safeQuestionFormat,
        questions: cloneQuestionsForStorage(practiceResult.questions),
        providerLabel: practiceResult.providerLabel || "AI",
        startedAt,
      })
      return
    } catch (error) {
      console.error("Leerling-oefentoets genereren mislukt:", error instanceof Error ? error.message : error)
      if (sourceContext) {
        socket.emit("player:error", {
          message: "De AI kon van dit bronmateriaal geen goede oefentoets maken. Probeer een duidelijkere bijlage of een concreter onderwerp.",
        })
        return
      }
    }

    const fallbackQuestions = buildFallbackQuestions({
      topic: trimmedTopic,
      questionCount: safeQuestionCount,
      questionFormat: safeQuestionFormat,
    }).slice(0, safeQuestionCount)
    upsertSelfPracticeSession(profile, {
      sessionId,
      title: `Oefentoets over ${topicLabel}`,
      topic: trimmedTopic,
      topicLabel,
      questionFormat: safeQuestionFormat,
      providerLabel: "Lokale reserve",
      questionTotal: fallbackQuestions.length,
      answeredCount: 0,
      correctCount: 0,
      status: "active",
      startedAt,
      updatedAt: startedAt,
      finishedAt: "",
      recentAnswers: [],
    })
    socket.emit("player:self-practice:started", {
      sessionId,
      title: `Oefentoets over ${topicLabel}`,
      instructions: "Werk zelfstandig, kijk na elke vraag naar de uitleg en ga daarna verder.",
      topic: trimmedTopic,
      topicLabel,
      questionFormat: safeQuestionFormat,
      questions: fallbackQuestions,
      providerLabel: "Lokale reserve",
      startedAt,
    })
  })

  socket.on("player:self-practice:progress", async ({ name, learnerCode, session }) => {
    await ensureClassroomsHydratedFromCloud()
    const profile = resolveLearnerPortalProfile(name, learnerCode)
    if (!profile) return
    upsertSelfPracticeSession(profile, session)
  })

  socket.on("player:answer", ({ answer, typedAnswer }) => {
    const room = getRoomBySocketId(socket.id)
    if (!room) return
    const question = currentQuestion(room)
    const player = getPlayerBySocketId(room, socket.id)
    if (!question || !player || room.answeredPlayers.has(player.id)) return

    if (room.game.status !== "live") return

    const startTime = room.game.questionStartedAt ? new Date(room.game.questionStartedAt).getTime() : 0
    const currentDuration = Number(question.durationSec) || room.game.questionDurationSec
    const now = Date.now()
    const withinAnswerWindow = startTime && now <= startTime + currentDuration * 1000 + ANSWER_GRACE_MS
    if (!withinAnswerWindow) return

    const questionType = normalizePracticeQuestionFormat(question.questionType)
    const submittedTypedAnswer = String(typedAnswer ?? "").trim()
    if (questionType === "typed" && room.game.source !== "practice") {
      socket.emit("player:error", { message: "Dit type vraag is alleen beschikbaar in de oefentoets." })
      return
    }
    if (questionType === "typed" && !submittedTypedAnswer) {
      socket.emit("player:error", { message: "Typ eerst je antwoord in." })
      return
    }
    if (questionType !== "typed" && !Number.isInteger(answer)) {
      socket.emit("player:error", { message: "Kies eerst een antwoordoptie." })
      return
    }

    room.answeredPlayers.add(player.id)
    const correctAnswer =
      String(question.displayAnswer || question.options?.[question.correctIndex] || question.acceptedAnswers?.[0] || "").trim()
    const acceptedAnswers = questionType === "typed" ? normalizeAcceptedAnswers(question) : []
    const isCorrect =
      questionType === "typed"
        ? acceptedAnswers.some((candidate) => matchesExpectedCandidate(submittedTypedAnswer, candidate))
        : answer === question.correctIndex
    const elapsedMs = Math.max(0, now - startTime)
    const scoring = isCorrect
      ? getBattleAnswerScoring(room, elapsedMs, currentDuration)
      : {
          multiplier: Math.max(1, Number(room.game.questionMultiplier) || 1),
          basePoints: 0,
          speedBonus: 0,
          awardedPoints: 0,
        }
    room.playerAnswers.set(player.id, {
      answerIndex: questionType === "typed" ? null : answer,
      answerText: questionType === "typed" ? submittedTypedAnswer : "",
      correctAnswer,
      acceptedAnswers,
      isCorrect,
      elapsedMs,
      awardedPoints: scoring.awardedPoints,
      basePoints: scoring.basePoints,
      speedBonus: scoring.speedBonus,
      multiplier: scoring.multiplier,
    })
    if (isCorrect) player.score += scoring.awardedPoints

    syncTeamScores(room)
    if (room.game.source === "practice") {
      socket.emit(
        "player:answer:result",
        buildPlayerAnswerResultPayload(room, player, room.playerAnswers.get(player.id), question)
      )
    } else {
      socket.emit("player:answer:result", {
        answerIndex: answer,
        waitingForReveal: true,
        playerScore: player.score,
        teamScore: room.teams.find((team) => team.id === player.teamId)?.score ?? 0,
      })
    }
    emitStateToRoom(room)
  })

  socket.on("player:math:answer", ({ answer }) => {
    const room = getRoomBySocketId(socket.id)
    if (!room || room.game.mode !== "math") return

    const player = getPlayerBySocketId(room, socket.id)
    if (!player) return
    const progress = ensureMathProgress(room, player.id)
    if (!progress?.currentTask || progress.awaitingNext) {
      socket.emit("player:error", { message: "Open eerst de volgende rekensom." })
      return
    }

    const task = progress.currentTask
    const evaluation = evaluateMathTask(task, answer)
    const submittedAt = new Date().toISOString()
    const expectedAnswer = formatMathAnswer(evaluation.expected)
    const answeredValue =
      evaluation.candidate === null ? String(answer ?? "").trim() : formatMathAnswer(evaluation.candidate)
    const studentExplanation = buildChildFriendlyMathExplanation(task, expectedAnswer)
    const baseHistoryEntry = {
      taskId: task.id,
      prompt: task.prompt,
      domain: task.domain,
      phase: progress.phase,
      level: task.level,
      difficulty: clampMathDifficulty(task.difficulty),
      correct: evaluation.correct,
      expectedAnswer,
      answeredValue,
      explanation: studentExplanation,
      answeredAt: submittedAt,
      pointsAwarded: 0,
    }

    progress.lastAnsweredAt = submittedAt
    progress.updatedAt = submittedAt
    room.math.updatedAt = submittedAt

    if (progress.phase === "intake") {
      const canRetryThisTask = !evaluation.correct && progress.intakeRetryTaskId !== task.id

      if (canRetryThisTask) {
        progress.intakeRetryTaskId = task.id
        progress.lastResult = {
          phase: "intake-review",
          correct: false,
          expectedAnswer: "",
          answeredValue,
          explanation: task?.hint ? `Tip: ${String(task.hint).trim()}` : "Kijk nog eens rustig naar de som en reken hem opnieuw uit.",
          feedback: "Denk je dat je een tikfout maakte? Klik op 'Pas antwoord aan' en probeer deze vraag nog 1 keer.",
          canRetry: true,
          pointsAwarded: 0,
        }
        emitStateToRoom(room)
        return
      }

      progress.intakeRetryTaskId = ""
      progress.intakeAnswers.push({
        questionId: task.id,
        level: task.level,
        domain: task.domain,
        correct: evaluation.correct,
      })

      const hasMoreIntakeQuestions = progress.intakeIndex + 1 < room.math.intakeQuestions.length
      if (hasMoreIntakeQuestions) {
        progress.intakeIndex += 1
        progress.awaitingNext = true
        progress.currentTask = null
        progress.lastResult = {
          phase: "intake",
          correct: evaluation.correct,
          expectedAnswer,
          answeredValue,
          explanation: studentExplanation,
          feedback: evaluation.correct
            ? "Goed gedaan. Dit antwoord klopt. Tik op 'Volgende vraag' om verder te gaan."
            : "Nog niet goed. Kijk rustig naar de uitleg hieronder en ga dan verder.",
          pointsAwarded: 0,
        }
      } else {
        const placementLevel = determineMathPlacement(room.math, progress)
        const targetLevel = getNextMathLevel(placementLevel)
        progress.phase = "practice"
        progress.placementLevel = placementLevel
        progress.targetLevel = targetLevel
        progress.practiceDifficulty = Math.max(2, clampMathDifficulty(mathLevelIndex(targetLevel) + 1))
        progress.awaitingNext = true
        progress.currentTask = null
        progress.lastResult = {
          phase: "placement",
          correct: evaluation.correct,
          expectedAnswer,
          answeredValue,
          explanation: studentExplanation,
          placementLevel,
          targetLevel,
          feedback: `Instaptoets klaar. Jij laat nu ${formatMathLevel(placementLevel)} zien en gaat oefenen op ${formatMathLevel(targetLevel)}.`,
          pointsAwarded: 0,
        }
      }
      appendMathAnswerHistory(progress, baseHistoryEntry)
    } else {
      progress.practiceQuestionCount += 1
      if (evaluation.correct) {
        progress.practiceCorrectCount += 1
        player.score += Number(task.points) || 0
      }
      updateMathDifficulty(progress, evaluation.correct)
      progress.awaitingNext = true
      progress.currentTask = null
      progress.lastResult = {
        phase: "practice",
        correct: evaluation.correct,
        expectedAnswer,
        answeredValue,
        explanation: studentExplanation,
        placementLevel: progress.placementLevel,
        targetLevel: progress.targetLevel,
        feedback: evaluation.correct
          ? `Goed! Je krijgt ${task.points} punten. De volgende som past bij ${formatMathLevel(progress.targetLevel)}.`
          : "Dat antwoord klopt nog niet. Kijk rustig naar de uitleg hieronder. Daarna krijg je een nieuwe som.",
        pointsAwarded: evaluation.correct ? Number(task.points) || 0 : 0,
      }
      appendMathAnswerHistory(progress, {
        ...baseHistoryEntry,
        pointsAwarded: evaluation.correct ? Number(task.points) || 0 : 0,
      })
    }

    syncTeamScores(room)
    syncMathGrowthForPlayer(room, player, progress)
    emitStateToRoom(room)
  })

  socket.on("player:math:next", () => {
    const room = getRoomBySocketId(socket.id)
    if (!room || room.game.mode !== "math") return

    const player = getPlayerBySocketId(room, socket.id)
    if (!player) return
    const progress = ensureMathProgress(room, player.id)
    if (!progress?.awaitingNext) return

    if (progress.phase === "intake") {
      progress.currentTask = cloneMathTask(room.math.intakeQuestions[progress.intakeIndex])
    } else {
      if (!progress.targetLevel) {
        progress.targetLevel = getNextMathLevel(progress.placementLevel || room.math.selectedBand)
      }
      progress.currentTask = generateAdaptivePracticeTask(progress)
    }

    progress.awaitingNext = false
    progress.lastResult = null
    progress.updatedAt = new Date().toISOString()
    room.math.updatedAt = progress.updatedAt
    emitStateToRoom(room)
  })

  socket.on("player:math:retry-intake", () => {
    const room = getRoomBySocketId(socket.id)
    if (!room || room.game.mode !== "math") return

    const player = getPlayerBySocketId(room, socket.id)
    if (!player) return
    const progress = ensureMathProgress(room, player.id)
    if (!progress?.currentTask || progress.phase !== "intake" || !progress.lastResult?.canRetry) return

    progress.lastResult = null
    progress.awaitingNext = false
    progress.updatedAt = new Date().toISOString()
    room.math.updatedAt = progress.updatedAt
    emitStateToRoom(room)
  })

  socket.on("player:lesson-response", async ({ response }) => {
    const room = getRoomBySocketId(socket.id)
    if (!room || room.game.mode !== "lesson") return

    const phase = currentLessonPhase(room)
    const player = getPlayerBySocketId(room, socket.id)
    if (!phase || !player) return

    const text = String(response ?? "").trim()
    if (!text) {
      socket.emit("player:error", { message: "Typ eerst een antwoord voordat je het verstuurt." })
      return
    }

    try {
      const evaluation = await evaluateLessonResponse(room.lesson, phase, text)
      room.lessonResponses.set(player.id, {
        text,
        isCorrect: evaluation.isCorrect,
        label: evaluation.label,
        feedback: evaluation.feedback,
        submittedAt: new Date().toISOString(),
      })

      socket.emit("player:lesson-response:result", {
        isCorrect: evaluation.isCorrect,
        label: evaluation.label,
        feedback: evaluation.feedback,
      })
      emitStateToRoom(room)
    } catch (error) {
      console.error("Lesantwoord kon niet worden beoordeeld:", error instanceof Error ? error.message : error)
      socket.emit("player:error", { message: "Je antwoord is ontvangen, maar de beoordeling liep vast. Probeer het nog eens." })
    }
  })

  socket.on("disconnect", () => {
    const room = getRoomBySocketId(socket.id)
    hostSocketIds.delete(socket.id)
    clearHostSession(socket.id)
    socketToRoom.delete(socket.id)
    if (!room) return

    if (room.hostSocketId === socket.id) {
      scheduleRoomClosure(room)
      emitStateToRoom(room)
      return
    }

    const player = getPlayerBySocketId(room, socket.id)
    if (!player) return

    player.socketId = null
    player.connected = false
    emitStateToRoom(room)
  })
})

server.listen(port, () => {
  console.log(`server draait op http://localhost:${port}`)
  if (mathCloudEnabled) {
    console.log(`math cloud persistence actief via Firestore project ${firebaseServiceAccount.projectId}`)
  } else {
    console.log("math cloud persistence staat uit; rekenvoortgang blijft dan afhankelijk van lokale opslag.")
  }
})
