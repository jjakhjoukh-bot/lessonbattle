import { useEffect, useMemo, useState } from "react"
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
const MATH_LEVEL_OPTIONS = ["0f", "1f", "2f", "3f", "4f"]
const PLAYER_JOIN_MODE_CLASSROOM = "classroom"
const PLAYER_JOIN_MODE_HOME_MATH = "home-math"
const DEFAULT_HOST_SESSION = {
  authenticated: false,
  username: "",
  displayName: "",
  role: "",
  canManageAccounts: false,
  roomCode: "",
  sessionToken: "",
}

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
  const [topic, setTopic] = useState("")
  const [audience, setAudience] = useState("vmbo")
  const [questionCount, setQuestionCount] = useState(12)
  const [questionDurationSec, setQuestionDurationSec] = useState(20)
  const [lessonModel, setLessonModel] = useState("edi")
  const [lessonPackage, setLessonPackage] = useState("lesson")
  const [mathBand, setMathBand] = useState("1f")
  const [lessonDurationMinutes, setLessonDurationMinutes] = useState(45)
  const [presentationSlideCount, setPresentationSlideCount] = useState(6)
  const [practiceQuestionCount, setPracticeQuestionCount] = useState(8)
  const [includeVideoPlan, setIncludeVideoPlan] = useState(false)
  const [lessonPromptDraft, setLessonPromptDraft] = useState("")
  const [lessonExpectedAnswerDraft, setLessonExpectedAnswerDraft] = useState("")
  const [teamNamesInput, setTeamNamesInput] = useState("Team Zon\nTeam Oceaan")
  const [groupModeEnabledDraft, setGroupModeEnabledDraft] = useState(false)
  const [isEditingTeams, setIsEditingTeams] = useState(false)
  const [status, setStatus] = useState("Vul het onderwerp in, kies eventueel groepen en start de ronde.")
  const [hostInsights, setHostInsights] = useState(null)
  const [lessonLibrary, setLessonLibrary] = useState([])
  const [sessionHistory, setSessionHistory] = useState([])
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
  const [loginForm, setLoginForm] = useState(storedHostSession.loginForm)
  const [hostSession, setHostSession] = useState(storedHostSession.hostSession)
  const [localRoomBackup, setLocalRoomBackup] = useState(() =>
    readHostRoomBackup(storedHostSession.hostSession.username || storedHostSession.loginForm.username)
  )
  const [manualSlideImageUrlDraft, setManualSlideImageUrlDraft] = useState("")
  const [manualSlideImageAltDraft, setManualSlideImageAltDraft] = useState("")
  const [manualSlideUploadName, setManualSlideUploadName] = useState("")
  const [slideImageBusy, setSlideImageBusy] = useState(false)

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
    const onLoginSuccess = ({ username, displayName, role, canManageAccounts, roomCode, sessionToken }) => {
      writeHostLastRoomCode(username || loginForm.username, roomCode)
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
      const username = hostSession.username || loginForm.username
      writeHostLastRoomCode(username, roomCode)
      setHostSession((current) => ({ ...current, roomCode }))
    }
    const onStarted = ({ message }) => setStatus(message)
    const onLessonStarted = ({ message }) => setStatus(message)
    const onLibraryUpdate = ({ lessons }) => setLessonLibrary(Array.isArray(lessons) ? lessons : [])
    const onHistoryUpdate = ({ entries }) => setSessionHistory(Array.isArray(entries) ? entries : [])
    const onTeacherAccountsUpdate = ({ accounts }) => setTeacherAccounts(Array.isArray(accounts) ? accounts : [])
    const onInsights = (payload) => {
      setHostInsights(payload)
      if (payload?.allAnswered && payload.totalPlayers > 0) {
        setStatus(
          payload.mode === "lesson"
            ? "Alle deelnemers hebben gereageerd. Je kunt naar de volgende lesstap."
            : "Alle deelnemers hebben geantwoord. Je kunt naar de volgende vraag."
        )
      }
    }
    const onError = ({ message }) => {
      setSlideImageBusy(false)
      setStatus(`Fout: ${message}`)
      if (/onjuiste docentgegevens|sessie verlopen|sessie niet meer geldig/i.test(String(message))) {
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
    const onPresentationImageSuccess = ({ manualImageUrl, imageAlt, sourceTitle, searchAttempt }) => {
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
      const username = hostSession.username || loginForm.username
      const storedBackup = writeHostRoomBackup(username, snapshot)
      if (storedBackup) setLocalRoomBackup(storedBackup)
    }
    const onBackupRestoreSuccess = ({ roomCode, title }) => {
      const username = hostSession.username || loginForm.username
      writeHostLastRoomCode(username, roomCode)
      setStatus(`Lokale backup hersteld${title ? `: ${title}` : ""}. Roomcode ${roomCode}.`)
    }

    socket.on("host:login:success", onLoginSuccess)
    socket.on("host:configure:success", onConfigureSuccess)
    socket.on("host:room:update", onRoomUpdate)
    socket.on("host:generate:started", onStarted)
    socket.on("host:generate-lesson:started", onLessonStarted)
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
    socket.on("host:history:load:success", onHistoryLoadSuccess)
    socket.on("host:history:delete:success", onHistoryDeleteSuccess)
    socket.on("host:teacher-accounts:success", onTeacherAccountsSuccess)
    socket.on("host:learner-code:success", onLearnerCodeSuccess)
    socket.on("host:presentation-image:success", onPresentationImageSuccess)
    socket.on("host:room:backup", onRoomBackup)
    socket.on("host:backup:restore:success", onBackupRestoreSuccess)

    return () => {
      socket.off("host:login:success", onLoginSuccess)
      socket.off("host:configure:success", onConfigureSuccess)
      socket.off("host:room:update", onRoomUpdate)
      socket.off("host:generate:started", onStarted)
      socket.off("host:generate-lesson:started", onLessonStarted)
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
      socket.off("host:history:load:success", onHistoryLoadSuccess)
      socket.off("host:history:delete:success", onHistoryDeleteSuccess)
      socket.off("host:teacher-accounts:success", onTeacherAccountsSuccess)
      socket.off("host:learner-code:success", onLearnerCodeSuccess)
      socket.off("host:presentation-image:success", onPresentationImageSuccess)
      socket.off("host:room:backup", onRoomBackup)
      socket.off("host:backup:restore:success", onBackupRestoreSuccess)
    }
  }, [hostSession.username, loginForm.username])

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
      if (!hostSession.authenticated || !hostSession.username || !hostSession.sessionToken) return
      socket.emit("host:restore-session", {
        sessionToken: hostSession.sessionToken,
        roomCode: hostSession.roomCode,
      })
    }

    if (socket.connected) reconnectHost()

    socket.on("connect", reconnectHost)
    return () => socket.off("connect", reconnectHost)
  }, [hostSession.authenticated, hostSession.roomCode, hostSession.sessionToken, hostSession.username])

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
    if (game.mode !== "lesson" || !game.lesson?.presentation?.currentSlide) {
      setStatus("Bouw eerst een les of presentatieset met dia's voordat je digibordmodus opent.")
      return
    }

    setPresenterMode(true)

    if (document.fullscreenElement) {
      setPresenterFullscreen(true)
      return
    }

    try {
      await document.documentElement.requestFullscreen()
      setPresenterFullscreen(true)
    } catch (error) {
      console.warn("Fullscreen kon niet worden gestart:", error)
      setStatus("Presentatie geopend. Schermvullend werd niet gestart, maar de digibordweergave staat wel open.")
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

  const login = () => {
    setStatus("Inloggegevens controleren...")
    const normalizedUsername = String(loginForm.username || "").trim()
    const rememberedRoomCode =
      readHostLastRoomCode(normalizedUsername) || readHostRoomBackup(normalizedUsername)?.roomCode || ""
    socket.emit("host:login", { ...loginForm, roomCode: rememberedRoomCode })
  }

  const logout = () => {
    const rememberedUsername = hostSession.username || loginForm.username
    socket.emit("host:logout")
    window.sessionStorage.removeItem(HOST_SESSION_KEY)
    setHostSession(DEFAULT_HOST_SESSION)
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
    socket.emit("host:start-math", { band: mathBand })
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

  return (
    <main className="page-shell host-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">Lesson Battle Arcade</span>
          <h1>Maak van je les een kleurrijke battle waar leerlingen direct in duiken.</h1>
          <p>
            Minder dashboardgevoel, meer spelgevoel: snelle battles, vrolijke presentaties en oefentoetsen
            die op iPad meteen duidelijk en aantrekkelijk aanvoelen voor leerlingen.
          </p>
          <div className="hero-tags">
            <span>Snelle battle</span>
            <span>Quiz vibes</span>
            <span>Presentatie slides</span>
            <span>Oefentoets</span>
            <span>Live reacties</span>
            <span>Teamenergie</span>
          </div>
        </div>
        <div className="hero-panel glass">
          <div className="hero-stat">
            <strong>{liveGroupModeEnabled ? teams.length : "Uit"}</strong>
            <span>{liveGroupModeEnabled ? "Actieve groepen" : "Groepsmodus"}</span>
          </div>
          <div className="hero-stat">
            <strong>{onlinePlayerCount}</strong>
            <span>Verbonden spelers</span>
          </div>
          <div className="hero-stat">
            <strong>{game.mode === "lesson" ? game.totalPhases || 0 : game.mode === "math" ? game.math?.intakeTotal || 0 : game.totalQuestions || questionCount}</strong>
            <span>{game.mode === "lesson" ? "Lesstappen klaar" : game.mode === "math" ? "Instapvragen klaar" : "Battlevragen klaar"}</span>
          </div>
          <button className="button-secondary present-button" onClick={togglePresenterMode} type="button">
            {presenterMode ? presenterFullscreen ? "Sluit digibordmodus" : "Sluit presentatie" : "Digibordmodus"}
          </button>
        </div>
      </section>

      {!hostSession.authenticated ? (
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
      ) : null}

      <section className="host-grid">
        <div className="glass control-card">
          <div className="section-head">
            <h2>Sessie-instellingen</h2>
            <span className="pill">{status}</span>
          </div>

          <div className="host-meta-bar">
            <div className="meta-card">
              <span>Account</span>
              <strong>{hostSession.displayName || hostSession.username || "Niet verbonden"}</strong>
              {hostSession.role ? <small className="meta-role">{hostSession.role === "owner" ? "Hoofdbeheer" : hostSession.role === "manager" ? "Beheerder" : "Docent"}</small> : null}
            </div>
            <div className="meta-card">
              <span>Spelcode</span>
              <strong>{hostSession.roomCode || "-----"}</strong>
            </div>
            <div className="meta-actions">
              <button className="button-ghost" onClick={() => socket.emit("host:room:refresh")} type="button">
                Nieuwe code
              </button>
              <button className="button-ghost subtle-danger" onClick={logout} type="button">
                Uitloggen
              </button>
            </div>
          </div>

          <div className="lobby-banner">
            <span>Deelnemers openen /join en gebruiken code</span>
            <strong>{hostSession.roomCode || "-----"}</strong>
          </div>

          <div className="suite-switch-panel">
            <div className="suite-switch-head">
              <h3>Lesmodus</h3>
              <span className="pill">Kies de vorm</span>
            </div>
            <div className="mode-switch main-mode-switch">
              <button
                className={`mode-chip ${selectedSuiteMode === "lesson" ? "is-active" : ""}`}
                onClick={() => selectSessionMode("lesson")}
                type="button"
              >
                Lesmodus
              </button>
              <button
                className={`mode-chip ${selectedSuiteMode === "presentation" ? "is-active" : ""}`}
                onClick={() => selectSessionMode("presentation")}
                type="button"
              >
                Presentatieweergave
              </button>
              <button
                className={`mode-chip ${selectedSuiteMode === "practice" ? "is-active" : ""}`}
                onClick={() => selectSessionMode("practice")}
                type="button"
              >
                Oefentoets
              </button>
              <button
                className={`mode-chip ${selectedSuiteMode === "math" ? "is-active" : ""}`}
                onClick={() => selectSessionMode("math")}
                type="button"
              >
                Rekenen
              </button>
            </div>
            <div className="battle-shortcut-row">
              <button
                className={`mode-chip mode-chip-secondary ${sessionMode === "battle" ? "is-active" : ""}`}
                onClick={() => selectSessionMode("battle")}
                type="button"
              >
                Battle
              </button>
              <span className="muted">Snelle quizronde zonder lesopbouw.</span>
            </div>
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

          <div className="field-row">
            {controlMode === "math" ? (
              <div className="field math-config-card">
                <span>Rekenroute</span>
                <p>
                  Leerlingen krijgen eerst een instaptoets. Daarna plaatst de site hen op een F-niveau en biedt
                  automatisch sommen aan op het volgende niveau. Hun leercode blijft zichtbaar zodat ze later weer
                  verder kunnen.
                </p>
              </div>
            ) : (
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
            )}

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
                    <select value="oefentoets" disabled>
                      <option value="oefentoets">Oefentoets</option>
                    </select>
                  </label>
                </>
              )
            ) : controlMode === "math" ? (
              <div className="field math-config-card">
                <span>Doel</span>
                <p>
                  De intake bepaalt het instapniveau. Bij een uitkomst op 1F gaat de leerling bijvoorbeeld verder met
                  2F-opgaven. Bij goede antwoorden loopt de moeilijkheid binnen dat niveau op.
                </p>
              </div>
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

          {controlMode !== "math" ? (
            <>
              <div className="toggle-grid">
                <button
                  className={`toggle-card ${!groupModeEnabledDraft ? "is-active" : ""}`}
                  onClick={() => setGroupModeEnabledDraft(false)}
                  type="button"
                >
                  <span>Instelling</span>
                  <strong>Individueel werken</strong>
                  <p>Leerlingen vullen alleen hun naam en spelcode in. Er worden geen groepen gebruikt.</p>
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
            </>
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
                disabled={!hostSession.authenticated}
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

        <div className="glass question-stage">
          <div className="section-head">
            <h2>{game.mode === "lesson" ? "Live les" : game.mode === "math" ? "Live rekenen" : "Live vraag"}</h2>
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
                  duration={battleDurationDraft}
                  finalSprintActive={game.finalSprintActive}
                  onDurationChange={setBattleDurationDraft}
                  onReveal={showBattleAnswer}
                  onStart={startBattleQuestion}
                  questionMultiplier={game.questionMultiplier}
                  status={game.status}
                />
              ) : null}
              <HostInsightsCard insights={hostInsights} />
            </>
          ) : game.status === "finished" ? (
            <ResultsCard teams={teams} leaderboard={leaderboard} showGroups={liveGroupModeEnabled} />
          ) : (
            <LobbyCard
              groupModeEnabled={liveGroupModeEnabled}
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

      {hostSession.authenticated ? (
        <LessonLibrarySection
          activeLessonId={game.lesson?.libraryId || null}
          lessons={lessonLibrary}
          onDelete={deleteLessonFromLibrary}
          onLoad={loadLessonFromLibrary}
        />
      ) : null}

      {hostSession.authenticated ? (
        <SessionHistorySection
          entries={sessionHistory}
          onDelete={deleteSessionFromHistory}
          onLoad={loadSessionFromHistory}
        />
      ) : null}

      {hostSession.authenticated && hostSession.canManageAccounts ? (
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

      {presenterMode && game.mode === "lesson" && game.lesson?.presentation?.currentSlide ? (
        <LessonPresenterOverlay
          insights={hostInsights}
          lesson={game.lesson}
          onClose={closePresenterMode}
          onPrevious={goToPreviousStep}
          onNext={goToNextStep}
        />
      ) : null}
    </main>
  )
}

function PlayerPage() {
  const { players, teams, leaderboard, game } = useQuizState()
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
  const [name, setName] = useState(playerSession.name || "")
  const [teamId, setTeamId] = useState(playerSession.teamId || "")
  const [roomCode, setRoomCode] = useState(playerSession.roomCode || "")
  const [playerId, setPlayerId] = useState(playerSession.playerId || "")
  const [playerSessionId, setPlayerSessionId] = useState(playerSession.playerSessionId || createPlayerSessionId())
  const [learnerCode, setLearnerCode] = useState(playerSession.learnerCode || "")
  const [joinMode, setJoinMode] = useState(playerSession.joinMode || PLAYER_JOIN_MODE_CLASSROOM)
  const [roomPreview, setRoomPreview] = useState({ valid: false, teams: [], intakeTotal: 0, mode: "battle", groupModeEnabled: false })
  const [joined, setJoined] = useState(Boolean(playerSession.joined))
  const [homeMathSession, setHomeMathSession] = useState(null)
  const [result, setResult] = useState(null)
  const [chosenAnswer, setChosenAnswer] = useState(null)
  const [answerLocked, setAnswerLocked] = useState(false)
  const [mathAnswer, setMathAnswer] = useState("")
  const [lessonAnswer, setLessonAnswer] = useState("")
  const [lessonResult, setLessonResult] = useState(null)
  const [status, setStatus] = useState("Vul je gegevens in en sluit aan.")
  const timeLeft = useQuestionCountdown(game)
  const liveResult = game.mode === "math" ? game.math?.lastResult || null : result
  const isLocalHomeMath = Boolean(homeMathSession)

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
    const onJoined = (nextMode = roomPreview.mode) => {
      setHomeMathSession(null)
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
          setStatus("Je gaat verder met je opgeslagen thuisroute op dit apparaat.")
          return
        }
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
        setStatus("Deze spelcode bestaat niet.")
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

    socket.on("player:joined", onJoinedPayload)
    socket.on("player:error", onPlayerError)
    socket.on("player:removed", onRemoved)
    socket.on("player:room:preview", onRoomPreview)
    socket.on("player:answer:result", onAnswerResult)
    socket.on("player:lesson-response:result", onLessonResponseResult)
    socket.on("player:profile:update", onProfileUpdate)

    return () => {
      socket.off("player:joined", onJoinedPayload)
      socket.off("player:error", onPlayerError)
      socket.off("player:removed", onRemoved)
      socket.off("player:room:preview", onRoomPreview)
      socket.off("player:answer:result", onAnswerResult)
      socket.off("player:lesson-response:result", onLessonResponseResult)
      socket.off("player:profile:update", onProfileUpdate)
    }
  }, [joinMode, learnerCode, name, roomCode.length])

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
    setStatus("Je opgeslagen thuisroute is direct geladen.")
  }, [homeMathSession, joinMode, joined, learnerCode, name])

  useEffect(() => {
    if (joined) return
    setStatus(
      joinMode === PLAYER_JOIN_MODE_HOME_MATH
        ? "Vul je naam en leerlingcode in om thuis verder te gaan."
        : "Vul je gegevens in en sluit aan."
    )
  }, [joinMode, joined])

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
      const localSnapshot = readHomeMathSnapshot(name.trim(), learnerCode)
      const localMath = activateHomeMathSnapshot(localSnapshot)
      if (localMath) {
        setHomeMathSession(localMath)
        setJoined(true)
        if (localSnapshot?.roomCode) setRoomCode(localSnapshot.roomCode)
        setStatus("Je thuisroute staat klaar. Je kunt direct verder.")
      }
      socket.emit("player:resume-math", {
        name: name.trim(),
        learnerCode,
        playerSessionId,
      })
      return
    }

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
  const canAnswerLiveQuestion =
    joined &&
    game.mode === "battle" &&
    game.status === "live" &&
    game.question &&
    !battleRevealVisible &&
    !result
  const canSubmitAnswer = joined && game.question && (canAnswerLiveQuestion || isPracticeTestLive) && !answerLocked
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

  if (isLocalHomeMath) {
    return (
      <main className="page-shell player-shell">
        <section className="player-layout">
          <div className="glass join-card">
            <span className="eyebrow">Deelnemen</span>
            <h1>Ga thuis verder</h1>
            <p className="muted">{status}</p>

            <div className="mode-switch join-mode-switch">
              <button
                className={`mode-chip ${joinMode === PLAYER_JOIN_MODE_CLASSROOM ? "is-active" : ""}`}
                onClick={() => {
                  setJoinMode(PLAYER_JOIN_MODE_CLASSROOM)
                  setHomeMathSession(null)
                  setJoined(false)
                  setStatus("Vul je gegevens in en sluit aan.")
                }}
                type="button"
              >
                In de klas
              </button>
              <button
                className={`mode-chip ${isHomeMathJoin ? "is-active" : ""}`}
                onClick={() => setJoinMode(PLAYER_JOIN_MODE_HOME_MATH)}
                type="button"
              >
                Thuis rekenen
              </button>
            </div>

            <label className="field">
              <span>Jouw naam</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Bijv. Amina" />
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
              Verder met rekenen
            </button>

            <p className="muted learner-code-note">
              Je opgeslagen thuisroute staat op dit apparaat klaar. Vul alleen je naam en leerlingcode in om door te gaan.
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

  return (
    <main className="page-shell player-shell">
      <section className="player-layout">
        <div className="glass join-card">
          <span className="eyebrow">Deelnemen</span>
          <h1>{isHomeMathJoin ? "Ga thuis verder" : isMathPreview ? "Start rekenen" : "Join de battle"}</h1>
          <p className="muted">{status}</p>

          <div className="mode-switch join-mode-switch">
            <button
              className={`mode-chip ${joinMode === PLAYER_JOIN_MODE_CLASSROOM ? "is-active" : ""}`}
              onClick={() => setJoinMode(PLAYER_JOIN_MODE_CLASSROOM)}
              type="button"
            >
              In de klas
            </button>
            <button
              className={`mode-chip ${isHomeMathJoin ? "is-active" : ""}`}
              onClick={() => setJoinMode(PLAYER_JOIN_MODE_HOME_MATH)}
              type="button"
            >
              Thuis rekenen
            </button>
          </div>

          <label className="field">
            <span>Jouw naam</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Bijv. Amina" />
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
              <span>Spelcode</span>
              <input
                value={roomCode}
                onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
                placeholder="Bijv. AB12C"
              />
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
            {joined ? "Opnieuw koppelen" : isHomeMathJoin ? "Verder met rekenen" : "Ik doe mee"}
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
          {!isHomeMathJoin ? (
            <div className="join-home-note">
              <strong>Thuis verder?</strong>
              <p>Klik hierboven op Thuis rekenen. Dan vul je alleen je naam en leerlingcode in. Een spelcode is thuis niet nodig.</p>
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
                        disabled={!canSubmitAnswer}
                        onClick={() => {
                          if (!canSubmitAnswer) return
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
        <span>Route</span>
        <strong>{math.selectedBand || "-"}</strong>
      </div>
      <div className="player-score-pill">
        <span>Instapvragen</span>
        <strong>{math.intakeTotal || 0}</strong>
      </div>
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

  return (
    <section className="math-host-panel">
      <div className="math-host-hero">
        <div>
          <span className="eyebrow">Adaptief rekenen</span>
          <h3>{math.title || `Rekenroute ${math.selectedBand}`}</h3>
          <p>
            Leerlingen maken eerst precies {math.intakeTotal || 0} instapvragen. Daarna krijgen ze automatisch sommen op het volgende niveau,
            met oplopende moeilijkheid als het goed gaat.
          </p>
        </div>
        <div className="math-host-actions">
          <div className="math-summary-stack">
            <span className="score-chip">Instap {math.intakeTotal || 0} vragen</span>
            <span className="score-chip">{math.intakeCount || 0} in intake</span>
            <span className="score-chip">{math.practiceCount || 0} aan het oefenen</span>
            {localBackup?.savedAt ? <span className="score-chip">Lokale backup {formatHistoryDate(localBackup.savedAt)}</span> : null}
          </div>
          <div className="math-host-actions-row">
            <button className="button-ghost" onClick={() => setShowOverview((current) => !current)} type="button">
              {showOverview ? "Verberg voortgang" : "Toon voortgang"}
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
              <small>Focus: {(player.focusDomains || []).map(formatMathDomainLabel).join(", ") || "nog bepalen"}</small>
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
            <span>Voeg leerlingen toe en geef ze een eenvoudige 4-cijferige code.</span>
          </div>
        </div>
        <div className="math-create-row">
          <input
            className="math-code-input"
            onChange={(event) => onNewLearnerChange((current) => ({ ...current, name: event.target.value }))}
            placeholder="Naam leerling"
            value={newMathLearner.name}
          />
          <input
            className="math-code-input"
            inputMode="numeric"
            maxLength={4}
            onChange={(event) =>
              onNewLearnerChange((current) => ({ ...current, learnerCode: event.target.value.replace(/\D/g, "").slice(0, 4) }))
            }
            placeholder="4 cijfers of leeg"
            value={newMathLearner.learnerCode}
          />
          <button className="button-primary" onClick={onCreateLearner} type="button">
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
              <span>Werkhouding: {player.workLabel || "Nog niet gestart"}</span>
              <span>Gemaakt: {player.answeredCount || 0}</span>
              <span>Goed: {player.correctCount || 0}</span>
              <span>Fout: {player.wrongCount || 0}</span>
              <span>Nauwkeurigheid: {formatAccuracy(player.accuracyRate || 0)}</span>
              <span>Laatste actief: {player.lastAnsweredAt ? formatHistoryDate(player.lastAnsweredAt) : "Nog geen activiteit"}</span>
              <span>Plaatsing: {player.placementLevel || "-"}</span>
              <span>Oefenniveau: {player.targetLevel || "-"}</span>
              <span>Moeilijkheid: {formatMathDifficultyLabel(player.practiceDifficulty)}</span>
              <span>Focus nu: {(player.focusDomains || []).map(formatMathDomainLabel).join(", ") || "nog bepalen"}</span>
              <span>
                Goed: {player.practiceCorrectCount || 0} / {player.practiceQuestionCount || 0}
              </span>
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

  return (
    <section className="math-student-panel">
      <div className="math-student-strip">
        <span className="score-chip">Route {math.selectedBand || "-"}</span>
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
            <span>Spelcode in de klas</span>
            <strong>{roomCode}</strong>
          </div>
        ) : null}
      </div>
      <p className="muted">In de klas gebruik je spelcode + leerlingcode. Thuis ga je verder met alleen je naam + leerlingcode.</p>
    </section>
  )
}

function QuestionCard({ question, compact = false, showOptions = true }) {
  const prompt = getQuestionPrompt(question)

  return (
    <article className={`question-card ${compact ? "compact" : ""}`}>
      <div className="question-visual-wrap">
        <QuestionVisual question={question} />
      </div>
      <div className="question-body">
        <span className="category-badge">{question.category}</span>
        <h3>{prompt}</h3>
        {showOptions ? (
          <ul className="option-list">
            {question.options.map((option, index) => (
              <li key={`${question.id}-preview-${index}`}>
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
            <span className="pill">{lesson.practiceTest.questionCount} vragen klaar</span>
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

function BattleQuestionControls({ status, duration, onDurationChange, onStart, onReveal, questionMultiplier, finalSprintActive }) {
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
          <p>De vraag staat live. Je ziet hieronder direct het juiste antwoord en de antwoordverdeling.</p>
          <button className="button-secondary" onClick={onReveal} type="button">
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

function LessonLibrarySection({ lessons, activeLessonId, onLoad, onDelete }) {
  return (
    <section className="glass board-card lesson-library-section">
      <div className="section-head">
        <h2>Lesbibliotheek</h2>
        <span className="pill">{lessons.length} opgeslagen</span>
      </div>

      {lessons.length ? (
        <div className="lesson-library-grid">
          {lessons.map((lesson) => (
            <article className={`lesson-library-card ${lesson.id === activeLessonId ? "is-active" : ""}`} key={lesson.id}>
              <div className="lesson-library-head">
                <div>
                  <span className="eyebrow">{lesson.model}</span>
                  <h3>{lesson.title}</h3>
                </div>
                <span className="pill">{lesson.durationMinutes} min</span>
              </div>
              <p>{lesson.lessonGoal}</p>
              <div className="lesson-library-meta">
                <span>{lesson.topic || "Algemeen thema"}</span>
                <span>{lesson.audience}</span>
                <span>{lesson.phaseCount} fasen</span>
                {lesson.practiceQuestionCount ? <span>{lesson.practiceQuestionCount} oefenvragen</span> : null}
                {lesson.slideCount ? <span>{lesson.slideCount} dia's</span> : null}
              </div>
              <div className="lesson-library-actions">
                <button className="button-secondary" onClick={() => onLoad(lesson.id)} type="button">
                  Open les
                </button>
                <button className="button-ghost" onClick={() => onDelete(lesson.id)} type="button">
                  Verwijder
                </button>
              </div>
            </article>
          ))}
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

function SessionHistorySection({ entries, onLoad, onDelete }) {
  return (
    <section className="glass board-card lesson-library-section session-history-section">
      <div className="section-head">
        <h2>Sessiegeschiedenis</h2>
        <span className="pill">{entries.length} bewaard</span>
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

function LobbyCard({ roomCode, teams, players, onlineCount, groupModeEnabled = false }) {
  return (
    <div className="lobby-card">
      <span className="eyebrow">Wachtruimte</span>
      <h3>Open de quiz en voer de code in</h3>
      <div className="lobby-code">{roomCode || "-----"}</div>
      <p>
        Open <strong>/join</strong>, voer de code in en vul je naam in.
        {groupModeEnabled ? " Een groep kiezen is mogelijk, maar niet verplicht." : " Deze sessie werkt individueel, dus een groep kiezen hoeft niet."}
        {" "}Zodra de ronde start, verschijnen de vragen hier live.
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

export default App
