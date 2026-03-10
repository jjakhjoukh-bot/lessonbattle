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
    status: "idle",
    currentQuestionIndex: -1,
    totalQuestions: 0,
    question: null,
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
  const [topic, setTopic] = useState("")
  const [audience, setAudience] = useState("vmbo")
  const [questionCount, setQuestionCount] = useState(12)
  const [questionDurationSec, setQuestionDurationSec] = useState(20)
  const [teamNamesInput, setTeamNamesInput] = useState("Team Zon\nTeam Oceaan")
  const [status, setStatus] = useState("Vul het onderwerp in, stel de teams in en start de ronde.")
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

  useEffect(() => {
    if (teams.length > 0) {
      setTeamNamesInput(teams.map((team) => team.name).join("\n"))
    }
  }, [teams])

  useEffect(() => {
    const onLoginSuccess = ({ username, roomCode }) => {
      setHostSession((current) => ({ ...current, authenticated: true, username, roomCode }))
      setStatus("Beheeraccount verbonden.")
    }
    const onRoomUpdate = ({ roomCode }) => {
      setHostSession((current) => ({ ...current, roomCode }))
    }
    const onStarted = ({ message }) => setStatus(message)
    const onError = ({ message }) => {
      setStatus(`Fout: ${message}`)
      if (/onjuiste docentgegevens|log eerst in als docent/i.test(String(message))) {
        setHostSession((current) => ({ ...current, authenticated: false, roomCode: "" }))
      }
    }
    const onSuccess = ({ count }) => setStatus(`${count} vragen klaar. De ronde is live.`)

    socket.on("host:login:success", onLoginSuccess)
    socket.on("host:room:update", onRoomUpdate)
    socket.on("host:generate:started", onStarted)
    socket.on("host:error", onError)
    socket.on("host:generate:success", onSuccess)

    return () => {
      socket.off("host:login:success", onLoginSuccess)
      socket.off("host:room:update", onRoomUpdate)
      socket.off("host:generate:started", onStarted)
      socket.off("host:error", onError)
      socket.off("host:generate:success", onSuccess)
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
    socket.emit("host:configure", { teamNames: preparedTeamNames })
    setStatus("Teams bijgewerkt.")
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

  return (
    <main className="page-shell host-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">Lesson Battle Live</span>
          <h1>Maak van elk onderwerp een energieke teamquiz.</h1>
          <p>
            Deze versie kan brede thema&apos;s aan. Typ zelf het onderwerp, niveau en de gewenste
            focus; de vragen, visuals en teamscores worden daarna live opgebouwd.
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
            <strong>{game.totalQuestions || questionCount}</strong>
            <span>Vragen in ronde</span>
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
            <h2>Quizinstellingen</h2>
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

          <label className="field">
            <span>Onderwerp</span>
            <textarea
              rows="4"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="Bijv. economie vmbo leerjaar 3 over verzekeringen en sparen"
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

          <div className="action-row">
            <button
              className="button-secondary"
              disabled={!hostSession.authenticated}
              onClick={configureTeams}
              type="button"
            >
              Teams opslaan
            </button>
            <button className="button-primary" disabled={!hostSession.authenticated} onClick={generate} type="button">
              Ronde starten
            </button>
            <button
              className="button-secondary"
              disabled={!hostSession.authenticated}
              onClick={() => socket.emit("host:next")}
              type="button"
            >
              Volgende vraag
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
            <h2>Live vraag</h2>
            <div className="pill-row">
              <span className="pill timer-pill">{game.status === "live" ? `${timeLeft}s` : "Klaar"}</span>
              <span className="pill">
              {game.status === "live"
                ? `Vraag ${game.currentQuestionIndex + 1} / ${game.totalQuestions}`
                : game.status === "finished"
                  ? "Ronde klaar"
                  : "Nog niet gestart"}
              </span>
            </div>
          </div>

          <ProgressBar current={game.currentQuestionIndex + 1} total={game.totalQuestions} timeLeft={timeLeft} duration={game.questionDurationSec} />

          {game.question ? (
            <QuestionCard question={game.question} />
          ) : game.status === "finished" ? (
            <ResultsCard teams={teams} leaderboard={leaderboard} />
          ) : (
            <LobbyCard roomCode={hostSession.roomCode} teams={teams} players={players} />
          )}
        </div>
      </section>

      <section className="dashboard-grid">
        <ScoreBoard teams={teams} leaderboard={leaderboard} />
        <RosterBoard players={players} teams={teams} />
      </section>
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
  const [status, setStatus] = useState("Vul je gegevens in en sluit aan.")
  const timeLeft = useQuestionCountdown(game)

  useSoundEffects(result, game.status)

  useEffect(() => {
    const sourceTeams = roomPreview.valid ? roomPreview.teams : teams
    if (!teamId && sourceTeams[0]?.id) {
      setTeamId(sourceTeams[0].id)
    }
  }, [roomPreview, teamId, teams])

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
    const onAnswerResult = (payload) => {
      setResult(payload)
      setStatus(payload.correct ? "Goed antwoord. Je team pakt punten." : "Niet correct. Probeer de volgende vraag.")
    }

    socket.on("player:joined", onJoined)
    socket.on("player:error", onPlayerError)
    socket.on("player:room:preview", onRoomPreview)
    socket.on("player:answer:result", onAnswerResult)

    return () => {
      socket.off("player:joined", onJoined)
      socket.off("player:error", onPlayerError)
      socket.off("player:room:preview", onRoomPreview)
      socket.off("player:answer:result", onAnswerResult)
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
    setResult(null)
    setChosenAnswer(null)
  }, [game.question?.id])

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

  const availableTeams = roomPreview.valid ? roomPreview.teams : teams
  const selectedTeam = availableTeams.find((team) => team.id === teamId)

  return (
    <main className="page-shell player-shell">
      <section className="player-layout">
        <div className="glass join-card">
          <span className="eyebrow">Deelnemen</span>
          <h1>Sluit aan bij de quiz</h1>
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
            <h2>Huidige vraag</h2>
            <div className="pill-row">
              <span className="pill timer-pill">{game.status === "live" ? `${timeLeft}s` : "Wachten"}</span>
              <span className="pill">
                {game.status === "live" ? `Vraag ${game.currentQuestionIndex + 1}` : "Wachten"}
              </span>
            </div>
          </div>

          {game.question ? (
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
            <ResultsCard teams={teams} leaderboard={leaderboard} />
          ) : (
            <div className="empty-state">
              <h3>De ronde start zo</h3>
              <p>Zodra de beheerder de ronde start, verschijnt de vraag hier automatisch.</p>
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

function RosterBoard({ players, teams, compact = false }) {
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
                <span>{player.name}</span>
                <strong>{player.score}</strong>
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
