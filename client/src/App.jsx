import { useEffect, useMemo, useState } from "react"
import { io } from "socket.io-client"
import "./App.css"

const socket = io(window.location.origin.startsWith("http://localhost:5173") ? "http://localhost:3001" : window.location.origin)

const TOPIC_PRESETS = [
  "Breuken en procenten",
  "Aardrijkskunde Europa",
  "Nederlandse spelling",
  "Engelse woordenschat",
  "Biologie van het menselijk lichaam",
  "Islamitische kennis",
  "Gemixte algemene kennis",
]

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
  const [topic, setTopic] = useState("Brede quiz over schoolvakken, algemene kennis en islamitische kennis")
  const [audience, setAudience] = useState("vmbo")
  const [questionCount, setQuestionCount] = useState(12)
  const [teamNamesInput, setTeamNamesInput] = useState("Team Zon\nTeam Oceaan")
  const [status, setStatus] = useState("Kies onderwerp, stel teams in en start de battle.")
  const [loginForm, setLoginForm] = useState({ username: "", password: "" })
  const [hostSession, setHostSession] = useState({ authenticated: false, username: "", roomCode: "" })

  useEffect(() => {
    if (teams.length > 0) {
      setTeamNamesInput(teams.map((team) => team.name).join("\n"))
    }
  }, [teams])

  useEffect(() => {
    const onLoginSuccess = ({ username, roomCode }) => {
      setHostSession({ authenticated: true, username, roomCode })
      setStatus("Docentaccount verbonden.")
    }
    const onRoomUpdate = ({ roomCode }) => {
      setHostSession((current) => ({ ...current, roomCode }))
    }
    const onStarted = ({ message }) => setStatus(message)
    const onError = ({ message }) => setStatus(`Fout: ${message}`)
    const onSuccess = ({ count }) => setStatus(`${count} vragen klaar. De battle is live.`)

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
    setStatus("Docentlogin controleren...")
    socket.emit("host:login", loginForm)
  }

  const generate = () => {
    setStatus("AI is nieuwe vragen en visuals aan het maken...")
    socket.emit("host:generate", {
      topic,
      audience,
      questionCount,
      teamNames: preparedTeamNames,
    })
  }

  return (
    <main className="page-shell host-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">Lesson Battle Live</span>
          <h1>Maak van elke les een energieke teamquiz.</h1>
          <p>
            Deze versie kan brede thema&apos;s aan: schoolvakken, algemene kennis, cultuur en
            islamitische kennis. Per vraag wordt een bijpassende AI-visual geladen en de teamscores
            lopen live mee.
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
        </div>
      </section>

      {!hostSession.authenticated ? (
        <section className="glass control-card login-card">
          <div className="section-head">
            <h2>Docent login</h2>
            <span className="pill">{status}</span>
          </div>
          <div className="field-row">
            <label className="field">
              <span>Gebruikersnaam</span>
              <input
                value={loginForm.username}
                onChange={(event) => setLoginForm((current) => ({ ...current, username: event.target.value }))}
                placeholder="docent"
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
              Inloggen als docent
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
              <span>Docent</span>
              <strong>{hostSession.username || "Niet ingelogd"}</strong>
            </div>
            <div className="meta-card">
              <span>Spelcode</span>
              <strong>{hostSession.roomCode || "-----"}</strong>
            </div>
            <button className="button-ghost" onClick={() => socket.emit("host:room:refresh")} type="button">
              Nieuwe code
            </button>
          </div>

          <label className="field">
            <span>Onderwerp of mix</span>
            <textarea
              rows="4"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="Bijv. Brugklas aardrijkskunde, rekenen, islamitische kennis en algemene kennis"
            />
          </label>

          <div className="preset-row">
            {TOPIC_PRESETS.map((preset) => (
              <button key={preset} className="chip" onClick={() => setTopic(preset)} type="button">
                {preset}
              </button>
            ))}
          </div>

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
              AI battle starten
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
              Reset ronde
            </button>
          </div>
        </div>

        <div className="glass question-stage">
          <div className="section-head">
            <h2>Live vraag</h2>
            <span className="pill">
              {game.status === "live"
                ? `Vraag ${game.currentQuestionIndex + 1} / ${game.totalQuestions}`
                : game.status === "finished"
                  ? "Ronde klaar"
                  : "Nog niet gestart"}
            </span>
          </div>

          {game.question ? (
            <QuestionCard question={game.question} />
          ) : game.status === "finished" ? (
            <ResultsCard teams={teams} leaderboard={leaderboard} />
          ) : (
            <div className="empty-state">
              <h3>Start een ronde</h3>
              <p>Na het genereren verschijnt hier direct de huidige vraag met visual en antwoordopties.</p>
            </div>
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
  const [name, setName] = useState("")
  const [teamId, setTeamId] = useState("")
  const [roomCode, setRoomCode] = useState("")
  const [joined, setJoined] = useState(false)
  const [result, setResult] = useState(null)
  const [chosenAnswer, setChosenAnswer] = useState(null)
  const [status, setStatus] = useState("Kies je team en doe mee.")

  useEffect(() => {
    if (!teamId && teams[0]?.id) {
      setTeamId(teams[0].id)
    }
  }, [teamId, teams])

  useEffect(() => {
    const onJoined = () => {
      setJoined(true)
      setStatus("Je bent binnen. Wacht op de vraag of geef meteen antwoord.")
    }
    const onPlayerError = ({ message }) => setStatus(message)
    const onAnswerResult = (payload) => {
      setResult(payload)
      setStatus(payload.correct ? "Goed antwoord. Je team pakt punten." : "Helaas, niet goed.")
    }

    socket.on("player:joined", onJoined)
    socket.on("player:error", onPlayerError)
    socket.on("player:answer:result", onAnswerResult)

    return () => {
      socket.off("player:joined", onJoined)
      socket.off("player:error", onPlayerError)
      socket.off("player:answer:result", onAnswerResult)
    }
  }, [])

  useEffect(() => {
    setResult(null)
    setChosenAnswer(null)
  }, [game.question?.id])

  const join = () => {
    socket.emit("player:join", { name, teamId, roomCode })
  }

  const selectedTeam = teams.find((team) => team.id === teamId)

  return (
    <main className="page-shell player-shell">
      <section className="player-layout">
        <div className="glass join-card">
          <span className="eyebrow">Join The Arena</span>
          <h1>Speel mee in Lesson Battle</h1>
          <p className="muted">{status}</p>

          <label className="field">
            <span>Jouw naam</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Bijv. Amina" />
          </label>

          <label className="field">
            <span>Kies je team</span>
            <select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
              {teams.map((team) => (
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

          <button className="button-primary" onClick={join} type="button">
            {joined ? "Team bijwerken" : "Meedoen"}
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
            <span className="pill">
              {game.status === "live" ? `Vraag ${game.currentQuestionIndex + 1}` : "Wachten"}
            </span>
          </div>

          {game.question ? (
            <>
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
              <h3>De battle komt zo</h3>
              <p>De docent genereert eerst de ronde. Zodra die live staat, verschijnt de vraag hier automatisch.</p>
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

function QuestionVisual({ question }) {
  const [hasImageError, setHasImageError] = useState(false)
  const imageUrl = buildQuestionImageUrl(question.imagePrompt || question.prompt)

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
  const winningTeam = [...teams].sort((left, right) => right.score - left.score)[0]
  const topPlayer = leaderboard[0]

  return (
    <div className="results-card">
      <span className="eyebrow">Ronde klaar</span>
      <h3>{winningTeam ? `${winningTeam.name} wint deze battle` : "De battle is afgelopen"}</h3>
      <p>
        {winningTeam ? `Eindsaldo: ${winningTeam.score} punten.` : "Bekijk hieronder de eindstand."}
        {topPlayer ? ` Topspeler: ${topPlayer.name} met ${topPlayer.score} punten.` : ""}
      </p>
      <div className="results-grid">
        {teams.map((team) => (
          <div className="result-tile" key={team.id} style={{ "--team-accent": team.color }}>
            <span>{team.name}</span>
            <strong>{team.score}</strong>
          </div>
        ))}
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
        <h2>Spelers per team</h2>
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

function buildQuestionImageUrl(prompt) {
  const searchParams = new URLSearchParams({
    prompt,
  })

  return `/api/question-image?${searchParams.toString()}`
}

export default App
