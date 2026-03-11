import { useEffect, useMemo, useState } from "react"
import { io } from "socket.io-client"
import "./App.css"

const socket = io(window.location.origin.startsWith("http://localhost:5173") ? "http://localhost:3001" : window.location.origin)
const HOST_SESSION_KEY = "lessonbattle-host-session"
const PLAYER_SESSION_KEY = "lessonbattle-player-session"
const DEFAULT_HOST_SESSION = { authenticated: false, username: "", roomCode: "" }

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

    socket.on("state:init", onInit)
    socket.on("players:update", setPlayers)
    socket.on("teams:update", setTeams)
    socket.on("leaderboard:update", setLeaderboard)
    socket.on("game:update", setGame)

    return () => {
      socket.off("state:init", onInit)
      socket.off("players:update", setPlayers)
      socket.off("teams:update", setTeams)
      socket.off("leaderboard:update", setLeaderboard)
      socket.off("game:update", setGame)
    }
  }, [])

  return { players, teams, leaderboard, game }
}

function HostPage() {
  const { players, teams, leaderboard, game } = useQuizState()
  const [sessionMode, setSessionMode] = useState("battle")
  const [topic, setTopic] = useState("")
  const [audience, setAudience] = useState("vmbo")
  const [questionCount, setQuestionCount] = useState(12)
  const [questionDurationSec, setQuestionDurationSec] = useState(20)
  const [lessonModel, setLessonModel] = useState("edi")
  const [lessonDurationMinutes, setLessonDurationMinutes] = useState(45)
  const [teamNamesInput, setTeamNamesInput] = useState("Team Zon\nTeam Oceaan")
  const [status, setStatus] = useState("Vul het onderwerp in, stel de teams in en start de ronde.")
  const [hostInsights, setHostInsights] = useState(null)
  const [lessonLibrary, setLessonLibrary] = useState([])
  const [loginForm, setLoginForm] = useState({ username: "", password: "" })
  const [hostSession, setHostSession] = useState(() => {
    try {
      const stored = window.localStorage.getItem(HOST_SESSION_KEY)
      if (!stored) return DEFAULT_HOST_SESSION
      const parsed = JSON.parse(stored)
      return {
        authenticated: false,
        username: parsed?.username || "",
        roomCode: "",
      }
    } catch {
      return DEFAULT_HOST_SESSION
    }
  })

  const activeMode = game.mode === "lesson" ? "lesson" : sessionMode

  useEffect(() => {
    if (teams.length > 0) {
      setTeamNamesInput(teams.map((team) => team.name).join("\n"))
    }
  }, [teams])

  useEffect(() => {
    if (game.lessonModel) setLessonModel(game.lessonModel)
    if (game.lessonDurationMinutes) setLessonDurationMinutes(game.lessonDurationMinutes)
  }, [game.lessonDurationMinutes, game.lessonModel])

  useEffect(() => {
    const onLoginSuccess = ({ username, roomCode }) => {
      setHostSession((current) => ({ ...current, authenticated: true, username, roomCode }))
      setStatus("Beheeraccount verbonden.")
    }
    const onConfigureSuccess = ({ teams: nextTeams }) => {
      const teamCount = Array.isArray(nextTeams) ? nextTeams.length : teams.length
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
        `${count} AI-vragen klaar${providerLabel ? ` via ${providerLabel}` : ""}. De ronde is live.`
      )
    const onLessonSuccess = ({ count, providerLabel, lessonModel: nextLessonModel }) =>
      setStatus(
        `${count} lesstappen klaar${providerLabel ? ` via ${providerLabel}` : ""}. ${String(nextLessonModel || "Lesmodus").toUpperCase()} is live.`
      )
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
      socket.off("host:save-lesson:success", onSaveLessonSuccess)
      socket.off("host:load-lesson:success", onLoadLessonSuccess)
      socket.off("host:delete-lesson:success", onDeleteLessonSuccess)
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(
      HOST_SESSION_KEY,
      JSON.stringify({
        username: hostSession.username,
      })
    )
  }, [hostSession.username])

  useEffect(() => {
    const onConnect = () => {
      if (!hostSession.authenticated || !loginForm.username || !loginForm.password) return
      socket.emit("host:login", {
        ...loginForm,
        roomCode: hostSession.roomCode,
      })
    }

    socket.on("connect", onConnect)
    return () => socket.off("connect", onConnect)
  }, [hostSession.authenticated, hostSession.roomCode, loginForm])

  useEffect(() => {
    if (!game.question) {
      setHostInsights(null)
    }
  }, [game.question?.id])

  const timeLeft = useQuestionCountdown(game)
  const [presenterMode, setPresenterMode] = useState(false)

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

  const preparedTeamNames = useMemo(
    () =>
      teamNamesInput
        .split(/\n|,/)
        .map((name) => name.trim())
        .filter(Boolean)
        .slice(0, 4),
    [teamNamesInput]
  )

  const configureTeams = () => {
    setStatus("Teams worden bijgewerkt...")
    socket.emit("host:configure", { teamNames: preparedTeamNames })
  }

  const login = () => {
    setStatus("Inloggegevens controleren...")
    socket.emit("host:login", { ...loginForm, roomCode: "" })
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

  const generateLesson = () => {
    setStatus("AI bouwt de lesopzet op...")
    socket.emit("host:generate-lesson", {
      topic,
      audience,
      lessonModel,
      durationMinutes: lessonDurationMinutes,
      teamNames: preparedTeamNames,
    })
  }

  const goToNextStep = () => {
    if (game.mode === "lesson" || activeMode === "lesson") {
      socket.emit("host:lesson-next")
      return
    }
    socket.emit("host:next")
  }

  const saveCurrentLesson = () => {
    setStatus("Les wordt opgeslagen in de bibliotheek...")
    socket.emit("host:save-lesson")
  }

  const loadLessonFromLibrary = (lessonId) => {
    setStatus("Les wordt geladen uit de bibliotheek...")
    socket.emit("host:load-lesson", { lessonId })
  }

  const deleteLessonFromLibrary = (lessonId) => {
    setStatus("Les wordt verwijderd uit de bibliotheek...")
    socket.emit("host:delete-lesson", { lessonId })
  }

  return (
    <main className="page-shell host-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">Lesson Battle Live</span>
          <h1>Bouw van elk onderwerp een live quiz of complete les.</h1>
          <p>
            Gebruik Battle voor tempo en competitie, of Lesmodus voor een interactieve lesopzet
            met lesdoel, fasen en actieve leerlingmomenten. Jij kiest de vorm; de sessie wordt
            daarna live opgebouwd voor docent en deelnemers.
          </p>
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
            <button className="button-ghost" onClick={() => socket.emit("host:room:refresh")} type="button">
              Nieuwe code
            </button>
          </div>

          <div className="lobby-banner">
            <span>Deelnemers openen /join en gebruiken code</span>
            <strong>{hostSession.roomCode || "-----"}</strong>
          </div>

          <div className="mode-switch">
            <button
              className={`mode-chip ${activeMode === "battle" ? "is-active" : ""}`}
              onClick={() => setSessionMode("battle")}
              type="button"
            >
              Battle
            </button>
            <button
              className={`mode-chip ${activeMode === "lesson" ? "is-active" : ""}`}
              onClick={() => setSessionMode("lesson")}
              type="button"
            >
              Lesmodus
            </button>
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
              <>
                <label className="field">
                  <span>Lesmodel</span>
                  <select value={lessonModel} onChange={(event) => setLessonModel(event.target.value)}>
                    <option value="edi">EDI</option>
                    <option value="directe instructie">Directe instructie</option>
                    <option value="formatief handelen">Formatief handelen</option>
                    <option value="activerende didactiek">Activerende didactiek</option>
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
              onChange={(event) => setTeamNamesInput(event.target.value)}
              placeholder="Eén team per regel"
            />
          </label>

          {activeMode === "lesson" ? (
            <LessonSummaryCard
              lesson={game.lesson}
              onSave={game.lesson?.phases?.length ? saveCurrentLesson : null}
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
              {activeMode === "lesson" ? "Les opbouwen" : "Ronde starten"}
            </button>
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
                  : game.status === "live"
                    ? `${timeLeft}s`
                    : "Klaar"}
              </span>
              <span className="pill">
                {game.mode === "lesson"
                  ? game.status === "live"
                    ? `Fase ${game.currentPhaseIndex + 1} / ${game.totalPhases}`
                    : game.status === "finished"
                      ? "Les afgerond"
                      : "Nog niet gestart"
                  : game.status === "live"
                    ? `Vraag ${game.currentQuestionIndex + 1} / ${game.totalQuestions}`
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
              <HostInsightsCard insights={hostInsights} />
            </>
          ) : game.mode === "lesson" && game.status === "finished" ? (
            <LessonCompleteCard lesson={game.lesson} />
          ) : game.question ? (
            <>
              <QuestionCard question={game.question} />
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
      setStatus(payload.correct ? "Goed antwoord. Je team pakt punten." : "Niet correct. Probeer de volgende vraag.")
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
  }, [game.lesson?.currentPhase?.id])

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
                  : game.status === "live"
                    ? `${timeLeft}s`
                    : "Wachten"}
              </span>
              <span className="pill">
                {game.mode === "lesson"
                  ? game.status === "live"
                    ? `Fase ${game.currentPhaseIndex + 1}`
                    : "Wachten"
                  : game.status === "live"
                    ? `Vraag ${game.currentQuestionIndex + 1}`
                    : "Wachten"}
              </span>
            </div>
          </div>

          {game.mode === "lesson" && game.lesson?.currentPhase ? (
            <>
              <LessonProgress lesson={game.lesson} />
              <LessonStageCard lesson={game.lesson} />
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
              <div className="answer-grid">
                {game.question.options.map((option, index) => {
                  const isCorrectChoice = result && index === result.correctIndex
                  const isWrongChosen = result && !result.correct && index === chosenAnswer

                  return (
                    <button
                      key={`${game.question.id}-${index}`}
                      className={`answer-button ${isCorrectChoice ? "is-correct" : ""} ${isWrongChosen ? "is-wrong" : ""}`}
                      disabled={!joined || Boolean(result)}
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
              {result ? (
                <div className={`answer-result ${result.correct ? "ok" : "bad"}`}>
                  <strong>{result.correct ? "Correct" : "Niet correct"}</strong>
                  <p>{result.explanation}</p>
                </div>
              ) : null}
            </>
          ) : game.status === "finished" ? (
            game.mode === "lesson" ? <LessonCompleteCard lesson={game.lesson} /> :
            <ResultsCard teams={teams} leaderboard={leaderboard} />
          ) : (
            <div className="empty-state">
              <h3>{game.mode === "lesson" ? "De les start zo" : "De ronde start zo"}</h3>
              <p>
                {game.mode === "lesson"
                  ? "Zodra de beheerder de les start, verschijnt de huidige lesstap hier automatisch."
                  : "Zodra de beheerder de ronde start, verschijnt de vraag hier automatisch."}
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
  return (
    <article className={`question-card ${compact ? "compact" : ""}`}>
      <div className="question-visual-wrap">
        <QuestionVisual question={question} />
      </div>
      <div className="question-body">
        <span className="category-badge">{question.category}</span>
        <h3>{question.prompt}</h3>
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

function LessonSummaryCard({ lesson, onSave }) {
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

  return (
    <article className="lesson-stage-card">
      <div className="lesson-stage-head">
        <div>
          <span className="category-badge">{lesson.model}</span>
          <h3>{hostView ? lesson.title : phase.title}</h3>
          <p className="muted">{hostView ? lesson.lessonGoal : "Werk deze stap uit en stuur jouw antwoord in."}</p>
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
        <p>{phase.goal}</p>
      </div>

      <div className="lesson-stage-grid">
        {hostView ? (
          <div className="lesson-box">
            <strong>Docentregie</strong>
            <p>{phase.teacherScript}</p>
          </div>
        ) : null}
        <div className="lesson-box">
          <strong>{hostView ? "Leerlingen doen nu" : "Jouw opdracht"}</strong>
          <p>{phase.studentActivity}</p>
        </div>
        <div className="lesson-box">
          <strong>Interactieve opdracht</strong>
          <p>{phase.interactivePrompt}</p>
        </div>
        <div className="lesson-box">
          <strong>Begrip checken</strong>
          <p>{phase.checkForUnderstanding}</p>
        </div>
      </div>
    </article>
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
            <strong>Verwacht antwoord</strong>
            <p>{insights.expectedAnswer}</p>
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

      {insights.allAnswered ? (
        <div className="answer-result ok">
          <strong>Iedereen is klaar. Juiste antwoord: {insights.correctOption}</strong>
          <p>{insights.explanation}</p>
        </div>
      ) : (
        <div className="answer-result">
          <strong>Nog niet iedereen heeft geantwoord.</strong>
          <p>Je kunt wachten of handmatig doorgaan naar de volgende vraag.</p>
        </div>
      )}

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
              {insights.allAnswered ? (
                <>
                  <span>{response.answerText || "Nog geen antwoord"}</span>
                  <b>{response.isCorrect ? "Goed" : response.answered ? "Fout" : "Open"}</b>
                </>
              ) : (
                <b>{response.answered ? "Geantwoord" : "Wacht nog"}</b>
              )}
            </div>
          </div>
        ))}
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
    if (!result) return

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
  const imageUrl = buildQuestionImageUrl(question.imagePrompt || question.prompt, question.category)

  useEffect(() => {
    setHasImageError(false)
  }, [question.id])

  if (hasImageError) {
    return (
      <div className="visual-fallback">
        <span className="visual-label">{question.category}</span>
        <strong>{question.imageAlt || question.prompt}</strong>
        <p>{question.prompt}</p>
      </div>
    )
  }

  return (
    <img
      alt={question.imageAlt || question.prompt}
      className="question-visual"
      onError={() => setHasImageError(true)}
      src={imageUrl}
    />
  )
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
