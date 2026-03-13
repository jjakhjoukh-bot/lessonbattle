import { useEffect, useMemo, useState } from "react"
import { io } from "socket.io-client"
import "./App.css"

const socket = io(window.location.origin.startsWith("http://localhost:5173") ? "http://localhost:3001" : window.location.origin)
const HOST_SESSION_KEY = "lessonbattle-host-session"
const PLAYER_SESSION_KEY = "lessonbattle-player-session"
const DEFAULT_HOST_SESSION = { authenticated: false, username: "", roomCode: "" }

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
    return {
      hostSession: {
        authenticated: Boolean(parsed?.authenticated && parsed?.username && parsed?.password),
        username: parsed?.username || "",
        roomCode: parsed?.roomCode || "",
      },
      loginForm: {
        username: parsed?.username || "",
        password: parsed?.password || "",
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
    currentQuestionIndex: -1,
    totalQuestions: 0,
    currentPhaseIndex: -1,
    totalPhases: 0,
    question: null,
    lesson: null,
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
  const [lessonDurationMinutes, setLessonDurationMinutes] = useState(45)
  const [presentationSlideCount, setPresentationSlideCount] = useState(6)
  const [practiceQuestionCount, setPracticeQuestionCount] = useState(8)
  const [includeVideoPlan, setIncludeVideoPlan] = useState(false)
  const [lessonPromptDraft, setLessonPromptDraft] = useState("")
  const [lessonExpectedAnswerDraft, setLessonExpectedAnswerDraft] = useState("")
  const [teamNamesInput, setTeamNamesInput] = useState("Team Zon\nTeam Oceaan")
  const [isEditingTeams, setIsEditingTeams] = useState(false)
  const [status, setStatus] = useState("Vul het onderwerp in, stel de teams in en start de ronde.")
  const [hostInsights, setHostInsights] = useState(null)
  const [lessonLibrary, setLessonLibrary] = useState([])
  const [loginForm, setLoginForm] = useState(storedHostSession.loginForm)
  const [hostSession, setHostSession] = useState(storedHostSession.hostSession)

  const activeMode = game.mode === "lesson" ? "lesson" : sessionMode === "battle" ? "battle" : "lesson"
  const includePracticeTest = lessonPackage === "practice" || lessonPackage === "complete"
  const includePresentation = lessonPackage === "presentation" || lessonPackage === "complete"
  const selectedSuiteMode =
    sessionMode === "battle" ? "battle" : includePresentation ? "presentation" : includePracticeTest ? "practice" : "lesson"
  const buildActionLabel =
    sessionMode === "battle"
      ? "Ronde klaarzetten"
      : selectedSuiteMode === "presentation"
        ? "Presentatie opbouwen"
        : selectedSuiteMode === "practice"
          ? "Oefentoets opbouwen"
          : "Les opbouwen"

  useEffect(() => {
    if (teams.length > 0 && !isEditingTeams) {
      setTeamNamesInput(teams.map((team) => team.name).join("\n"))
    }
  }, [teams, isEditingTeams])

  useEffect(() => {
    if (game.lessonModel) setLessonModel(game.lessonModel)
    if (game.lessonDurationMinutes) setLessonDurationMinutes(game.lessonDurationMinutes)
  }, [game.lessonDurationMinutes, game.lessonModel])

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
    const onLoginSuccess = ({ username, roomCode }) => {
      setHostSession((current) => ({ ...current, authenticated: true, username, roomCode }))
      setStatus("Beheeraccount verbonden.")
    }
    const onConfigureSuccess = ({ teams: nextTeams }) => {
      const teamCount = Array.isArray(nextTeams) ? nextTeams.length : teams.length
      if (Array.isArray(nextTeams) && nextTeams.length > 0) {
        setTeamNamesInput(nextTeams.map((team) => team.name).join("\n"))
      }
      setIsEditingTeams(false)
      setStatus(`${teamCount} teams opgeslagen.`)
    }
    const onRoomUpdate = ({ roomCode }) => {
      setHostSession((current) => ({ ...current, roomCode }))
    }
    const onStarted = ({ message }) => setStatus(message)
    const onLessonStarted = ({ message }) => setStatus(message)
    const onLibraryUpdate = ({ lessons }) => setLessonLibrary(Array.isArray(lessons) ? lessons : [])
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
      setStatus(`Fout: ${message}`)
      if (/onjuiste docentgegevens|log eerst in als docent/i.test(String(message))) {
        setHostSession((current) => ({ ...current, authenticated: false, roomCode: "" }))
      }
    }
    const onSuccess = ({ count, providerLabel }) =>
      setStatus(
        `${count} AI-vragen klaar${providerLabel ? ` via ${providerLabel}` : ""}. De eerste vraag staat klaar in docent-preview. Klik op Start vraag om hem live te zetten.`
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

    socket.on("host:login:success", onLoginSuccess)
    socket.on("host:configure:success", onConfigureSuccess)
    socket.on("host:room:update", onRoomUpdate)
    socket.on("host:generate:started", onStarted)
    socket.on("host:generate-lesson:started", onLessonStarted)
    socket.on("host:lesson-library:update", onLibraryUpdate)
    socket.on("host:question:insights", onInsights)
    socket.on("host:error", onError)
    socket.on("host:generate:success", onSuccess)
    socket.on("host:generate-lesson:success", onLessonSuccess)
    socket.on("host:lesson-prompt:success", onLessonPromptSuccess)
    socket.on("host:save-lesson:success", onSaveLessonSuccess)
    socket.on("host:load-lesson:success", onLoadLessonSuccess)
    socket.on("host:delete-lesson:success", onDeleteLessonSuccess)

    return () => {
      socket.off("host:login:success", onLoginSuccess)
      socket.off("host:configure:success", onConfigureSuccess)
      socket.off("host:room:update", onRoomUpdate)
      socket.off("host:generate:started", onStarted)
      socket.off("host:generate-lesson:started", onLessonStarted)
      socket.off("host:lesson-library:update", onLibraryUpdate)
      socket.off("host:question:insights", onInsights)
      socket.off("host:error", onError)
      socket.off("host:generate:success", onSuccess)
      socket.off("host:generate-lesson:success", onLessonSuccess)
      socket.off("host:lesson-prompt:success", onLessonPromptSuccess)
      socket.off("host:save-lesson:success", onSaveLessonSuccess)
      socket.off("host:load-lesson:success", onLoadLessonSuccess)
      socket.off("host:delete-lesson:success", onDeleteLessonSuccess)
    }
  }, [])

  useEffect(() => {
    window.sessionStorage.setItem(
      HOST_SESSION_KEY,
      JSON.stringify({
        authenticated: hostSession.authenticated,
        username: hostSession.username,
        password: loginForm.password,
        roomCode: hostSession.roomCode,
      })
    )
  }, [hostSession.authenticated, hostSession.roomCode, hostSession.username, loginForm.password])

  useEffect(() => {
    const reconnectHost = () => {
      if (!hostSession.authenticated || !loginForm.username || !loginForm.password) return
      socket.emit("host:login", {
        ...loginForm,
        roomCode: hostSession.roomCode,
      })
    }

    if (socket.connected) reconnectHost()

    socket.on("connect", reconnectHost)
    return () => socket.off("connect", reconnectHost)
  }, [hostSession.authenticated, hostSession.roomCode, loginForm])

  useEffect(() => {
    if (!game.question) {
      setHostInsights(null)
    }
  }, [game.question?.id])

  const timeLeft = useQuestionCountdown(game)
  const [presenterMode, setPresenterMode] = useState(false)
  const [battleDurationDraft, setBattleDurationDraft] = useState(questionDurationSec)

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen()
      setPresenterMode(true)
      return
    }

    await document.exitFullscreen()
    setPresenterMode(false)
  }

  useEffect(() => {
    const syncFullscreen = () => setPresenterMode(Boolean(document.fullscreenElement))
    document.addEventListener("fullscreenchange", syncFullscreen)
    return () => document.removeEventListener("fullscreenchange", syncFullscreen)
  }, [])

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
    setStatus("Teams worden bijgewerkt...")
    socket.emit("host:configure", { teamNames: preparedTeamNames })
  }

  const selectSessionMode = (nextMode) => {
    if (nextMode === "battle") {
      setSessionMode("battle")
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
    socket.emit("host:login", { ...loginForm, roomCode: "" })
  }

  const logout = () => {
    socket.emit("host:logout")
    window.sessionStorage.removeItem(HOST_SESSION_KEY)
    setHostSession(DEFAULT_HOST_SESSION)
    setLoginForm({ username: "", password: "" })
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
      includePracticeTest,
      includePresentation,
      includeVideoPlan: includePresentation && includeVideoPlan,
      teamNames: preparedTeamNames,
    })
  }

  const goToNextStep = () => {
    if (game.mode === "lesson") {
      socket.emit("host:lesson-next")
      return
    }
    socket.emit("host:next")
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

  const updateLessonPrompt = () => {
    setStatus("Live lesvraag wordt bijgewerkt...")
    socket.emit("host:lesson-prompt:update", {
      prompt: lessonPromptDraft,
      expectedAnswer: lessonExpectedAnswerDraft,
    })
  }

  return (
    <main className="page-shell host-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">Lesson Battle Live</span>
          <h1>Bouw van elk onderwerp een live quiz of complete les.</h1>
          <p>
            Gebruik Battle voor tempo en competitie, of kies in de lessuite voor Lesmodus,
            Presentatieweergave of Oefentoets. Jij kiest de vorm; de sessie wordt daarna live
            opgebouwd voor docent en deelnemers.
          </p>
          <div className="hero-tags">
            <span>Live battle</span>
            <span>Lesmodus</span>
            <span>Presentatieweergave</span>
            <span>Oefentoets</span>
            <span>Open antwoorden</span>
            <span>Lesfasen</span>
          </div>
        </div>
        <div className="hero-panel glass">
          <div className="hero-stat">
            <strong>{teams.length}</strong>
            <span>Actieve teams</span>
          </div>
          <div className="hero-stat">
            <strong>{players.length}</strong>
            <span>Verbonden spelers</span>
          </div>
          <div className="hero-stat">
            <strong>{game.mode === "lesson" ? game.totalPhases || 0 : game.totalQuestions || questionCount}</strong>
            <span>{game.mode === "lesson" ? "Lesfasen live" : "Vragen in ronde"}</span>
          </div>
          <button className="button-secondary present-button" onClick={toggleFullscreen} type="button">
            {presenterMode ? "Verlaat fullscreen" : "Presentatiemodus"}
          </button>
        </div>
      </section>

      {!hostSession.authenticated ? (
        <section className="glass control-card login-card">
          <div className="section-head">
            <h2>Beheerlogin</h2>
            <span className="pill">{status}</span>
          </div>
          <div className="field-row">
            <label className="field">
              <span>Gebruikersnaam</span>
              <input
                value={loginForm.username}
                onChange={(event) => setLoginForm((current) => ({ ...current, username: event.target.value }))}
                placeholder="gebruikersnaam"
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
              <strong>{hostSession.username || "Niet verbonden"}</strong>
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

          <label className="field">
            <span>Onderwerp</span>
            <textarea
              rows="4"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder={
                activeMode === "lesson"
                  ? "Bijv. procenten rekenen met korting voor vmbo basis, 45 minuten, veel interactie"
                  : "Bijv. economie vmbo leerjaar 3 over verzekeringen en sparen"
              }
            />
          </label>

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

            {activeMode === "lesson" ? (
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

          <label className="field">
            <span>Teams</span>
            <textarea
              rows="4"
              value={teamNamesInput}
              onChange={(event) => {
                setIsEditingTeams(true)
                setTeamNamesInput(event.target.value)
              }}
              placeholder="Eén team per regel"
            />
          </label>

          {activeMode === "lesson" ? (
            <LessonSummaryCard
              lesson={game.lesson}
              onSave={game.lesson?.phases?.length ? saveCurrentLesson : null}
              onStartPractice={game.lesson?.practiceTest?.questionCount ? startPracticeTest : null}
            />
          ) : null}

          <div className="action-row">
            <button
              className="button-secondary"
              disabled={!hostSession.authenticated}
              onClick={configureTeams}
              type="button"
            >
              Teams opslaan
            </button>
            <button
              className="button-primary"
              disabled={!hostSession.authenticated}
              onClick={activeMode === "lesson" ? generateLesson : generate}
              type="button"
            >
              {activeMode === "lesson" ? buildActionLabel : "Ronde starten"}
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
            <h2>{game.mode === "lesson" ? "Live les" : "Live vraag"}</h2>
            <div className="pill-row">
              <span className="pill timer-pill">
                {game.mode === "lesson"
                  ? game.lesson?.currentPhase
                    ? `${game.lesson.currentPhase.minutes} min`
                    : "Les"
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
          ) : (
            <ProgressBar
              current={game.currentQuestionIndex + 1}
              total={game.totalQuestions}
              timeLeft={timeLeft}
              duration={game.questionDurationSec}
            />
          )}

          {game.mode === "lesson" && game.lesson?.currentPhase ? (
            <>
              <LessonStageCard lesson={game.lesson} hostView />
              <LessonPresentationPanel presentation={game.lesson?.presentation} />
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
              <QuestionCard question={game.question} />
              {game.mode === "battle" && game.source !== "practice" ? (
                <BattleQuestionControls
                  duration={battleDurationDraft}
                  onDurationChange={setBattleDurationDraft}
                  onReveal={showBattleAnswer}
                  onStart={startBattleQuestion}
                  status={game.status}
                />
              ) : null}
              <HostInsightsCard insights={hostInsights} />
            </>
          ) : game.status === "finished" ? (
            <ResultsCard teams={teams} leaderboard={leaderboard} />
          ) : (
            <LobbyCard roomCode={hostSession.roomCode} teams={teams} players={players} />
          )}
        </div>
      </section>

      <section className="dashboard-grid">
        <ScoreBoard teams={teams} leaderboard={leaderboard} />
        <RosterBoard
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

      {presenterMode && game.mode === "lesson" && game.lesson?.presentation?.currentSlide ? (
        <LessonPresenterOverlay
          insights={hostInsights}
          lesson={game.lesson}
          onClose={toggleFullscreen}
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
      return stored ? JSON.parse(stored) : { name: "", teamId: "", roomCode: "", joined: false }
    } catch {
      return { name: "", teamId: "", roomCode: "", joined: false }
    }
  })
  const [name, setName] = useState(playerSession.name || "")
  const [teamId, setTeamId] = useState(playerSession.teamId || "")
  const [roomCode, setRoomCode] = useState(playerSession.roomCode || "")
  const [roomPreview, setRoomPreview] = useState({ valid: false, teams: [] })
  const [joined, setJoined] = useState(Boolean(playerSession.joined))
  const [result, setResult] = useState(null)
  const [chosenAnswer, setChosenAnswer] = useState(null)
  const [lessonAnswer, setLessonAnswer] = useState("")
  const [lessonResult, setLessonResult] = useState(null)
  const [status, setStatus] = useState("Vul je gegevens in en sluit aan.")
  const timeLeft = useQuestionCountdown(game)

  useSoundEffects(result, game.status)

  useEffect(() => {
    const sourceTeams = joined ? teams : roomPreview.valid ? roomPreview.teams : teams

    if (!sourceTeams.length) {
      if (teamId) setTeamId("")
      return
    }

    if (!sourceTeams.some((team) => team.id === teamId)) {
      setTeamId(sourceTeams[0].id)
    }
  }, [joined, roomPreview, teamId, teams])

  useEffect(() => {
    const onJoined = () => {
      setJoined(true)
      setStatus("Je bent verbonden. Wacht op de volgende vraag.")
    }
    const onPlayerError = ({ message }) => setStatus(message)
    const onRoomPreview = (payload) => {
      setRoomPreview(payload)
      if (payload.valid) {
        setStatus(`Room ${payload.roomCode} gevonden.`)
        if (payload.teams?.[0]?.id) {
          setTeamId((current) => current || payload.teams[0].id)
        }
      } else if (roomCode.length >= 5) {
        setStatus("Deze spelcode bestaat niet.")
      }
    }
    const onRemoved = ({ message }) => {
      setJoined(false)
      setResult(null)
      setChosenAnswer(null)
      setStatus(message || "Je bent verwijderd door de beheerder.")
    }
    const onAnswerResult = (payload) => {
      setResult(payload)
      if (payload.waitingForReveal) {
        setStatus("Je antwoord is opgeslagen. Wacht tot het juiste antwoord wordt getoond.")
        return
      }
      setStatus(payload.correct ? "Goed antwoord. Je team pakt punten." : "Niet correct. Kijk naar de uitleg en ga daarna verder.")
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

    socket.on("player:joined", onJoined)
    socket.on("player:error", onPlayerError)
    socket.on("player:removed", onRemoved)
    socket.on("player:room:preview", onRoomPreview)
    socket.on("player:answer:result", onAnswerResult)
    socket.on("player:lesson-response:result", onLessonResponseResult)

    return () => {
      socket.off("player:joined", onJoined)
      socket.off("player:error", onPlayerError)
      socket.off("player:removed", onRemoved)
      socket.off("player:room:preview", onRoomPreview)
      socket.off("player:answer:result", onAnswerResult)
      socket.off("player:lesson-response:result", onLessonResponseResult)
    }
  }, [roomCode.length])

  useEffect(() => {
    const nextSession = { name, teamId, roomCode, joined }
    setPlayerSession(nextSession)
    window.localStorage.setItem(PLAYER_SESSION_KEY, JSON.stringify(nextSession))
  }, [joined, name, roomCode, teamId])

  useEffect(() => {
    if (roomCode.trim().length < 5) {
      setRoomPreview({ valid: false, teams: [] })
      return
    }

    socket.emit("player:lookup-room", { roomCode: roomCode.trim().toUpperCase() })
  }, [roomCode])

  useEffect(() => {
    const normalizedCode = roomCode.trim().toUpperCase()

    if (joined || normalizedCode.length < 5) return undefined

    const intervalId = window.setInterval(() => {
      socket.emit("player:lookup-room", { roomCode: normalizedCode })
    }, 2000)

    return () => window.clearInterval(intervalId)
  }, [joined, roomCode])

  useEffect(() => {
    setResult(null)
    setChosenAnswer(null)
    setLessonAnswer("")
    setLessonResult(null)
  }, [game.question?.id])

  useEffect(() => {
    setLessonAnswer("")
    setLessonResult(null)
  }, [game.lesson?.currentPhase?.id, game.lesson?.currentPhase?.prompt, game.lesson?.promptVersion])

  useEffect(() => {
    const onConnect = () => {
      const normalizedCode = roomCode.trim().toUpperCase()
      if (normalizedCode.length >= 5) {
        socket.emit("player:lookup-room", { roomCode: normalizedCode })
      }
      if (joined && name.trim() && teamId && normalizedCode.length >= 5) {
        socket.emit("player:join", { name: name.trim(), teamId, roomCode: normalizedCode })
      }
    }

    socket.on("connect", onConnect)
    return () => socket.off("connect", onConnect)
  }, [joined, name, roomCode, teamId])

  const join = () => {
    socket.emit("player:join", { name: name.trim(), teamId, roomCode: roomCode.trim().toUpperCase() })
  }

  const submitLessonAnswer = () => {
    socket.emit("player:lesson-response", { response: lessonAnswer })
  }

  const availableTeams = joined ? teams : roomPreview.valid ? roomPreview.teams : teams
  const selectedTeam = availableTeams.find((team) => team.id === teamId)
  const isPracticeTestLive = game.source === "practice"
  const isLastPracticeQuestion = isPracticeTestLive && game.currentQuestionIndex + 1 >= game.totalQuestions
  const canAdvancePracticeQuestion =
    joined &&
    isPracticeTestLive &&
    game.question &&
    (Boolean(result) || timeLeft === 0)
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

  return (
    <main className="page-shell player-shell">
      <section className="player-layout">
        <div className="glass join-card">
          <span className="eyebrow">Deelnemen</span>
          <h1>Sluit aan bij de sessie</h1>
          <p className="muted">{status}</p>

          <label className="field">
            <span>Jouw naam</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Bijv. Amina" />
          </label>

          <label className="field">
            <span>Team</span>
            <select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
              {availableTeams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Spelcode</span>
            <input
              value={roomCode}
              onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
              placeholder="Bijv. AB12C"
            />
          </label>

          <button className="button-primary" disabled={!roomPreview.valid} onClick={join} type="button">
            {joined ? "Bijwerken" : "Verbinden"}
          </button>

          {selectedTeam ? (
            <div className="team-chip" style={{ "--team-accent": selectedTeam.color }}>
              {selectedTeam.name}
            </div>
          ) : null}
        </div>

        <div className="glass battle-card">
          <div className="section-head">
            <h2>{game.mode === "lesson" ? "Huidige lesstap" : "Huidige vraag"}</h2>
            <div className="pill-row">
              <span className="pill timer-pill">
                {game.mode === "lesson"
                  ? game.lesson?.currentPhase
                    ? `${game.lesson.currentPhase.minutes} min`
                    : "Wachten"
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

          {game.mode === "lesson" && game.lesson?.currentPhase ? (
            <>
              <LessonStageCard lesson={game.lesson} />
              <LessonPresentationPanel compact presentation={game.lesson?.presentation} />
              <LessonResponsePanel
                answer={lessonAnswer}
                disabled={!joined}
                onChange={setLessonAnswer}
                onSubmit={submitLessonAnswer}
                result={lessonResult}
              />
            </>
          ) : game.question ? (
            <>
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
                        className={`answer-button ${isCorrectChoice ? "is-correct" : ""} ${isWrongChosen ? "is-wrong" : ""}`}
                        disabled={!canAnswerLiveQuestion && !isPracticeTestLive}
                        onClick={() => {
                          setChosenAnswer(index)
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
                <div className={`answer-result ${chosenAnswer === game.question.correctIndex ? "ok" : "bad"}`}>
                  <strong>{chosenAnswer === game.question.correctIndex ? "Goed antwoord" : "Juiste antwoord"}</strong>
                  <p>
                    {game.question.options[game.question.correctIndex]}
                    {game.question.explanation ? ` — ${game.question.explanation}` : ""}
                  </p>
                </div>
              ) : null}
              {result && !result.waitingForReveal ? (
                <div className={`answer-result ${result.correct ? "ok" : "bad"}`}>
                  <strong>{result.correct ? "Correct" : "Niet correct"}</strong>
                  <p>{result.explanation}</p>
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
              <ResultsCard teams={teams} leaderboard={leaderboard} />
            )
          ) : (
            <div className="empty-state">
              <h3>{game.mode === "lesson" ? "De les verschijnt zo" : "Wacht op de volgende vraag"}</h3>
              <p>
                {game.mode === "lesson"
                  ? "De huidige lesstap verschijnt hier vanzelf zodra die live staat."
                  : "De docent bekijkt de vraag eerst en zet hem daarna live voor jou."}
              </p>
            </div>
          )}
        </div>

        <div className="glass side-column">
          <ScoreBoard teams={teams} leaderboard={leaderboard} compact />
          <RosterBoard players={players} teams={teams} compact />
        </div>
      </section>
    </main>
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
        <h3>{phase.studentActivity || "Werk mee met deze lesstap."}</h3>
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
  const prompt = slide?.imagePrompt || `${slide?.title || ""} ${slide?.focus || slide?.studentViewText || ""}`.trim()
  const imageUrl = prompt ? buildQuestionImageUrl(prompt, "Presentatie") : ""

  useEffect(() => {
    setHasImageError(false)
  }, [slide?.id])

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
      onError={() => setHasImageError(true)}
      src={imageUrl}
    />
  )
}

function PresentationSlideCanvas({ presentation, slide, compact = false }) {
  if (!slide) return null

  return (
    <article className={`presentation-slide-canvas ${compact ? "compact" : ""}`}>
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

function LessonPresentationPanel({ presentation, compact = false }) {
  if (!presentation?.currentSlide) return null

  return (
    <section className={`lesson-presentation-panel ${compact ? "compact" : ""}`}>
      <div className="section-head">
        <h3>{compact ? "Live dia" : "Presentatieweergave"}</h3>
        <span className="pill">
          {presentation.slideCount ? `${presentation.slideCount} dia's` : presentation.style || "Interactief"}
        </span>
      </div>
      <div className={`presentation-stage ${compact ? "compact" : ""}`}>
        <PresentationSlideCanvas compact={compact} presentation={presentation} slide={presentation.currentSlide} />
        {!compact && presentation.video ? (
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

function LessonPresenterOverlay({ lesson, insights, onNext, onClose }) {
  if (!lesson?.presentation?.currentSlide || !lesson?.currentPhase) return null

  const slide = lesson.presentation.currentSlide
  const videoScene = lesson.presentation.video?.currentScene || null
  const answeredCount = insights?.answeredCount ?? 0
  const totalPlayers = insights?.totalPlayers ?? 0

  return (
    <div className="presenter-overlay">
      <div className="presenter-backdrop" />
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
            <PresentationSlideCanvas presentation={lesson.presentation} slide={slide} />
          </article>

          <aside className="presenter-side-panel">
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
        </div>

        <div className="presenter-bottombar">
          <span className="presenter-hint">ESC of knop om fullscreen te verlaten</span>
          <div className="presenter-actions">
            <button className="button-ghost" onClick={onClose} type="button">
              Sluit presentatieweergave
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

function BattleQuestionControls({ status, duration, onDurationChange, onStart, onReveal }) {
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

function LessonResponsePanel({ answer, onChange, onSubmit, result, disabled }) {
  return (
    <section className="lesson-response-panel">
      <div className="section-head">
        <h3>Jouw antwoord</h3>
        <span className="pill">{result?.label || "Nog niet verstuurd"}</span>
      </div>

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
                  <b>Wacht nog</b>
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

      <div className="answer-result ok">
        <strong>Juiste antwoord: {insights.correctOption}</strong>
        <p>{insights.explanation || "De docent kan dit antwoord direct bespreken."}</p>
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
                  <b>{response.isCorrect ? "Goed" : "Fout"}</b>
                </>
              ) : (
                <b>Wacht nog</b>
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
  const imageUrl = buildQuestionImageUrl(question.imagePrompt || prompt, question.category)

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

function ResultsCard({ teams, leaderboard }) {
  const sortedTeams = [...teams].sort((left, right) => right.score - left.score)
  const winningTeam = sortedTeams[0]
  const topPlayer = leaderboard[0]

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

function LobbyCard({ roomCode, teams, players }) {
  return (
    <div className="lobby-card">
      <span className="eyebrow">Wachtruimte</span>
      <h3>Open de quiz en voer de code in</h3>
      <div className="lobby-code">{roomCode || "-----"}</div>
      <p>Open <strong>/join</strong>, voer de code in en kies een team. Zodra de ronde start, verschijnen de vragen hier live.</p>
      <div className="lobby-stats">
        <div className="result-tile">
          <span>Teams</span>
          <strong>{teams.length}</strong>
        </div>
        <div className="result-tile">
          <span>Spelers online</span>
          <strong>{players.length}</strong>
        </div>
      </div>
    </div>
  )
}

function ScoreBoard({ teams, leaderboard, compact = false }) {
  return (
    <section className={`glass board-card ${compact ? "compact" : ""}`}>
      <div className="section-head">
        <h2>Teamscore</h2>
        <span className="pill">Live</span>
      </div>
      <div className="team-score-list">
        {teams.map((team) => (
          <div className="team-score-card" key={team.id} style={{ "--team-accent": team.color }}>
            <div>
              <strong>{team.name}</strong>
              <span>Groepspunten</span>
            </div>
            <b>{team.score}</b>
          </div>
        ))}
      </div>

      <div className="mini-leaderboard">
        <h3>Top spelers</h3>
        {leaderboard.slice(0, 5).map((player, index) => (
          <div className="mini-row" key={player.id}>
            <span>{index + 1}. {player.name}</span>
            <strong>{player.score}</strong>
          </div>
        ))}
      </div>
    </section>
  )
}

function RosterBoard({ players, teams, compact = false, onRemovePlayer }) {
  return (
    <section className={`glass board-card ${compact ? "compact" : ""}`}>
      <div className="section-head">
        <h2>Deelnemers per team</h2>
        <span className="pill">{players.length} online</span>
      </div>
      <div className="roster-grid">
        {teams.map((team) => (
          <div className="roster-column" key={team.id} style={{ "--team-accent": team.color }}>
            <h3>{team.name}</h3>
            {(players.filter((player) => player.teamId === team.id).length
              ? players.filter((player) => player.teamId === team.id)
              : [{ id: `${team.id}-empty`, name: "Nog niemand", score: 0 }]).map((player) => (
              <div className="roster-row" key={player.id}>
                <div className="roster-row-main">
                  <span>{player.name}</span>
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
            ))}
          </div>
        ))}
      </div>
    </section>
  )
}

function buildQuestionImageUrl(prompt, category) {
  const searchParams = new URLSearchParams({
    prompt,
    category: category || "",
  })

  return `/api/question-image?${searchParams.toString()}`
}

export default App
