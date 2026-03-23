const HOME_MATH_PROGRESS_KEY = "lessonbattle-home-math-progress-v1"
const MATH_LEVELS = ["0f", "1f", "2f", "3f", "4f"]
const MATH_DOMAINS = ["getallen", "verhoudingen", "meten en meetkunde", "verbanden"]

function normalizeMathLevel(value = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
  return MATH_LEVELS.includes(normalized) ? normalized : "1f"
}

function mathLevelIndex(level) {
  return MATH_LEVELS.indexOf(normalizeMathLevel(level))
}

function getNextMathLevel(level) {
  const index = mathLevelIndex(level)
  return MATH_LEVELS[Math.min(MATH_LEVELS.length - 1, Math.max(0, index + 1))]
}

function clampMathDifficulty(value) {
  return Math.max(1, Math.min(5, Number(value) || 1))
}

function normalizeLearnerName(value = "") {
  return String(value || "").trim().toLowerCase()
}

function normalizeLearnerCode(value = "") {
  return String(value || "")
    .trim()
    .replace(/\D/g, "")
    .slice(0, 4)
}

function buildSnapshotKey(name = "", learnerCode = "") {
  return `${normalizeLearnerName(name)}::${normalizeLearnerCode(learnerCode)}`
}

function readStore() {
  try {
    return JSON.parse(window.localStorage.getItem(HOME_MATH_PROGRESS_KEY) || "{}")
  } catch {
    return {}
  }
}

function writeStore(store) {
  window.localStorage.setItem(HOME_MATH_PROGRESS_KEY, JSON.stringify(store))
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

function hashSeed(value = "") {
  let hash = 2166136261
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function createSeededRandom(seed = "") {
  let state = hashSeed(seed) || 1
  return () => {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 4294967296
  }
}

function randomInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min
}

function pickOne(rng, values) {
  return values[randomInt(rng, 0, values.length - 1)]
}

function createMathTask({ id, level, difficulty, domain, prompt, answer, tolerance = 0, hint = "", explanation = "", phase = "practice" }) {
  return {
    id,
    level: normalizeMathLevel(level),
    difficulty: clampMathDifficulty(difficulty),
    domain,
    prompt,
    answer: Number(answer) || 0,
    tolerance: Math.max(0, Number(tolerance) || 0),
    hint,
    explanation,
    phase,
  }
}

function buildTaskSeed(snapshot, phase, level, domain, position, difficulty) {
  return [
    snapshot.key,
    phase,
    level,
    domain,
    String(position ?? 0),
    String(difficulty ?? 1),
  ].join("|")
}

function generateTaskForLevel(level, difficulty = 2, domain = "getallen", snapshot, position = 0, phase = "practice") {
  const safeLevel = normalizeMathLevel(level)
  const safeDifficulty = clampMathDifficulty(difficulty)
  const safeDomain = MATH_DOMAINS.includes(domain) ? domain : MATH_DOMAINS[0]
  const rng = createSeededRandom(buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty))

  if (safeLevel === "0f") {
    if (safeDomain === "getallen") {
      const a = randomInt(rng, 6, 20 + safeDifficulty * 4)
      const b = randomInt(rng, 4, 15 + safeDifficulty * 3)
      return createMathTask({
        id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
        level: safeLevel,
        difficulty: safeDifficulty,
        domain: safeDomain,
        phase,
        prompt: `Hoeveel is ${a} + ${b}?`,
        answer: a + b,
        hint: "Begin bij het grootste getal en tel verder.",
        explanation: `${a} + ${b} = ${a + b}.`,
      })
    }
    if (safeDomain === "verhoudingen") {
      const boxes = pickOne(rng, [2, 3, 4, 5])
      const perBox = pickOne(rng, [2, 3, 4, 5])
      return createMathTask({
        id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
        level: safeLevel,
        difficulty: safeDifficulty,
        domain: safeDomain,
        phase,
        prompt: `In 1 doos zitten ${perBox} stiften. Hoeveel stiften zitten er in ${boxes} dozen?`,
        answer: boxes * perBox,
        hint: "Tel steeds hetzelfde aantal erbij op.",
        explanation: `${boxes} x ${perBox} = ${boxes * perBox}.`,
      })
    }
    if (safeDomain === "meten en meetkunde") {
      const euros = pickOne(rng, [2, 3, 4, 5])
      const cents = pickOne(rng, [20, 50, 80])
      const answer = roundTo(euros + cents / 100, 2)
      return createMathTask({
        id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
        level: safeLevel,
        difficulty: safeDifficulty,
        domain: safeDomain,
        phase,
        prompt: `Je hebt ${euros} euro en ${cents} cent. Hoeveel euro heb je samen?`,
        answer,
        tolerance: 0.01,
        hint: "100 cent is 1 euro.",
        explanation: `${euros} euro en ${cents} cent is samen ${formatMathAnswer(answer)} euro.`,
      })
    }
    const start = pickOne(rng, [2, 3, 4])
    const step = pickOne(rng, [2, 5, 10])
    return createMathTask({
      id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
      level: safeLevel,
      difficulty: safeDifficulty,
      domain: safeDomain,
      phase,
      prompt: `Week 1 = ${start} euro, week 2 = ${start + step} euro, week 3 = ${start + step * 2} euro. Hoeveel euro hoort bij week 4?`,
      answer: start + step * 3,
      hint: "Kijk hoeveel er elke stap bijkomt.",
      explanation: `Er komt steeds ${step} euro bij. Dus week 4 is ${start + step * 3}.`,
    })
  }

  if (safeLevel === "1f") {
    if (safeDomain === "getallen") {
      const a = randomInt(rng, 4, 12)
      const b = randomInt(rng, 3, 12)
      return createMathTask({
        id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
        level: safeLevel,
        difficulty: safeDifficulty,
        domain: safeDomain,
        phase,
        prompt: `Hoeveel is ${a} x ${b}?`,
        answer: a * b,
        hint: "Gebruik de tafel of splits het op.",
        explanation: `${a} x ${b} = ${a * b}.`,
      })
    }
    if (safeDomain === "verhoudingen") {
      if (rng() > 0.5) {
        const percent = pickOne(rng, [10, 25, 50])
        const base = pickOne(rng, [40, 60, 80, 100, 120, 200])
        const answer = roundTo((percent / 100) * base, 2)
        return createMathTask({
          id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
          level: safeLevel,
          difficulty: safeDifficulty,
          domain: safeDomain,
          phase,
          prompt: `Hoeveel is ${percent}% van ${base}?`,
          answer,
          tolerance: 0.01,
          hint: "Denk aan 10%, 25% of de helft.",
          explanation: `${percent}% van ${base} is ${formatMathAnswer(answer)}.`,
        })
      }
      const actualMetersPerCentimeter = pickOne(rng, [100, 200, 500])
      const mapDistance = pickOne(rng, [2, 3, 4, 5, 6])
      return createMathTask({
        id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
        level: safeLevel,
        difficulty: safeDifficulty,
        domain: safeDomain,
        phase,
        prompt: `Op een kaart is 1 cm in het echt ${actualMetersPerCentimeter} meter. Twee plekken liggen ${mapDistance} cm uit elkaar op de kaart. Hoeveel meter is dat in het echt?`,
        answer: actualMetersPerCentimeter * mapDistance,
        hint: "Reken eerst uit wat 1 cm betekent.",
        explanation: `${mapDistance} x ${actualMetersPerCentimeter} = ${actualMetersPerCentimeter * mapDistance} meter.`,
      })
    }
    if (safeDomain === "meten en meetkunde") {
      const width = pickOne(rng, [4, 5, 6, 7, 8])
      const height = pickOne(rng, [3, 4, 5, 6, 7])
      const answer = 2 * (width + height)
      return createMathTask({
        id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
        level: safeLevel,
        difficulty: safeDifficulty,
        domain: safeDomain,
        phase,
        prompt: `Een rechthoek is ${width} cm lang en ${height} cm breed. Hoeveel cm is de omtrek?`,
        answer,
        hint: "Tel lengte en breedte twee keer.",
        explanation: `${width} + ${height} + ${width} + ${height} = ${answer}.`,
      })
    }
    const first = pickOne(rng, [3, 4, 5])
    const step = pickOne(rng, [2, 3, 4])
    return createMathTask({
      id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
      level: safeLevel,
      difficulty: safeDifficulty,
      domain: safeDomain,
      phase,
      prompt: `Rit 1 = ${first} km, rit 2 = ${first + step} km, rit 3 = ${first + step * 2} km. Hoeveel km hoort bij rit 5?`,
      answer: first + step * 4,
      hint: "Kijk hoeveel er per stap bijkomt.",
      explanation: `Er komt steeds ${step} km bij. Rit 5 is ${first + step * 4}.`,
    })
  }

  if (safeLevel === "2f") {
    if (safeDomain === "getallen") {
      const a = pickOne(rng, [2.4, 3.75, 4.6, 5.25, 7.8])
      const b = pickOne(rng, [1.35, 2.2, 2.75, 3.4])
      const answer = roundTo(a + b, 2)
      return createMathTask({
        id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
        level: safeLevel,
        difficulty: safeDifficulty,
        domain: safeDomain,
        phase,
        prompt: `Hoeveel is ${formatMathAnswer(a)} + ${formatMathAnswer(b)}?`,
        answer,
        tolerance: 0.01,
        hint: "Zet de komma's recht onder elkaar.",
        explanation: `Het antwoord is ${formatMathAnswer(answer)}.`,
      })
    }
    if (safeDomain === "verhoudingen") {
      const price = pickOne(rng, [60, 80, 120, 160, 240])
      const discount = pickOne(rng, [15, 20, 25, 30])
      const answer = roundTo(price * (1 - discount / 100), 2)
      return createMathTask({
        id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
        level: safeLevel,
        difficulty: safeDifficulty,
        domain: safeDomain,
        phase,
        prompt: `Een jas kost ${price} euro. Er gaat ${discount}% korting af. Wat betaal je?`,
        answer,
        tolerance: 0.01,
        hint: "Reken uit hoeveel procent je nog wel betaalt.",
        explanation: `Na korting blijft ${100 - discount}% over. Dat is ${formatMathAnswer(answer)} euro.`,
      })
    }
    if (safeDomain === "meten en meetkunde") {
      const width = pickOne(rng, [3.2, 4.5, 5.6, 6.8])
      const length = pickOne(rng, [4.5, 5.5, 6.2, 7.4])
      const answer = roundTo(width * length, 2)
      return createMathTask({
        id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
        level: safeLevel,
        difficulty: safeDifficulty,
        domain: safeDomain,
        phase,
        prompt: `Een kamer is ${formatMathAnswer(length)} m lang en ${formatMathAnswer(width)} m breed. Wat is de oppervlakte in m2?`,
        answer,
        tolerance: 0.01,
        hint: "Gebruik lengte x breedte.",
        explanation: `${formatMathAnswer(length)} x ${formatMathAnswer(width)} = ${formatMathAnswer(answer)} m2.`,
      })
    }
    const values = [pickOne(rng, [6, 7, 8]), pickOne(rng, [7, 8, 9]), pickOne(rng, [8, 9, 10]), pickOne(rng, [9, 10, 11])]
    const answer = roundTo(values.reduce((sum, value) => sum + value, 0) / values.length, 2)
    return createMathTask({
      id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
      level: safeLevel,
      difficulty: safeDifficulty,
      domain: safeDomain,
      phase,
      prompt: `Je hebt de cijfers ${values.join(", ")}. Wat is het gemiddelde?`,
      answer,
      tolerance: 0.01,
      hint: "Tel alles op en deel door het aantal getallen.",
      explanation: `Het gemiddelde is ${formatMathAnswer(answer)}.`,
    })
  }

  if (safeLevel === "3f") {
    if (safeDomain === "getallen") {
      const a = pickOne(rng, [1.8, 2.4, 3.6, 4.25])
      const b = pickOne(rng, [1.25, 1.5, 2.2, 2.75])
      const answer = roundTo(a * b, 2)
      return createMathTask({
        id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
        level: safeLevel,
        difficulty: safeDifficulty,
        domain: safeDomain,
        phase,
        prompt: `Hoeveel is ${formatMathAnswer(a)} x ${formatMathAnswer(b)}?`,
        answer,
        tolerance: 0.01,
        hint: "Reken eerst zonder komma en zet hem daarna terug.",
        explanation: `Het antwoord is ${formatMathAnswer(answer)}.`,
      })
    }
    if (safeDomain === "verhoudingen") {
      const original = pickOne(rng, [80, 120, 150, 200, 240])
      const discount = pickOne(rng, [10, 20, 25, 30])
      const paid = roundTo(original * (1 - discount / 100), 2)
      return createMathTask({
        id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
        level: safeLevel,
        difficulty: safeDifficulty,
        domain: safeDomain,
        phase,
        prompt: `Na ${discount}% korting betaal je ${formatMathAnswer(paid)} euro. Wat was de oude prijs?`,
        answer: original,
        tolerance: 0.01,
        hint: "Bedenk welk percentage nog over is.",
        explanation: `Je deelt ${formatMathAnswer(paid)} door ${formatMathAnswer((100 - discount) / 100)} en krijgt ${original}.`,
      })
    }
    if (safeDomain === "meten en meetkunde") {
      const speed = pickOne(rng, [18, 24, 30, 45, 60])
      const hours = pickOne(rng, [1.5, 2, 2.25, 2.5, 3])
      const answer = roundTo(speed * hours, 2)
      return createMathTask({
        id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
        level: safeLevel,
        difficulty: safeDifficulty,
        domain: safeDomain,
        phase,
        prompt: `Je fietst ${speed} km per uur en rijdt ${formatMathAnswer(hours)} uur. Hoeveel kilometer leg je af?`,
        answer,
        tolerance: 0.01,
        hint: "Gebruik afstand = snelheid x tijd.",
        explanation: `${speed} x ${formatMathAnswer(hours)} = ${formatMathAnswer(answer)} kilometer.`,
      })
    }
    const x = randomInt(rng, 4, 14)
    const multiplier = pickOne(rng, [2, 3, 4, 5])
    const add = randomInt(rng, 3, 12)
    const total = multiplier * x + add
    return createMathTask({
      id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
      level: safeLevel,
      difficulty: safeDifficulty,
      domain: safeDomain,
      phase,
      prompt: `Los op: ${multiplier}x + ${add} = ${total}. Wat is x?`,
      answer: x,
      hint: "Werk stap voor stap terug.",
      explanation: `Eerst ${add} eraf, daarna delen door ${multiplier}. Dan krijg je ${x}.`,
    })
  }

  if (safeDomain === "getallen") {
    const principal = pickOne(rng, [500, 750, 1000, 1200, 1500])
    const rate = pickOne(rng, [2, 3, 4, 5])
    const years = pickOne(rng, [2, 3, 4])
    const answer = roundTo(principal * (1 + rate / 100) ** years, 2)
    return createMathTask({
      id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
      level: safeLevel,
      difficulty: safeDifficulty,
      domain: safeDomain,
      phase,
      prompt: `Je zet ${principal} euro op de bank tegen ${rate}% rente per jaar. Hoeveel staat er na ${years} jaar op de rekening?`,
      answer,
      tolerance: 0.05,
      hint: "Gebruik beginbedrag x groeifactor^jaren.",
      explanation: `Na ${years} jaar heb je ${formatMathAnswer(answer)} euro.`,
    })
  }
  if (safeDomain === "verhoudingen") {
    const excl = pickOne(rng, [80, 120, 175, 240])
    const answer = roundTo(excl * 1.21, 2)
    return createMathTask({
      id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
      level: safeLevel,
      difficulty: safeDifficulty,
      domain: safeDomain,
      phase,
      prompt: `Een product kost ${excl} euro zonder btw. Hoeveel betaal je met 21% btw erbij?`,
      answer,
      tolerance: 0.01,
      hint: "Met btw reken je met factor 1,21.",
      explanation: `${excl} x 1,21 = ${formatMathAnswer(answer)} euro.`,
    })
  }
  if (safeDomain === "meten en meetkunde") {
    const radius = pickOne(rng, [2.5, 3, 3.5, 4])
    const height = pickOne(rng, [8, 10, 12, 15])
    const answer = roundTo(Math.PI * radius * radius * height, 2)
    return createMathTask({
      id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
      level: safeLevel,
      difficulty: safeDifficulty,
      domain: safeDomain,
      phase,
      prompt: `Een cilinder heeft straal ${formatMathAnswer(radius)} cm en hoogte ${height} cm. Wat is de inhoud in cm3?`,
      answer,
      tolerance: 0.1,
      hint: "Gebruik pi x r x r x h.",
      explanation: `De inhoud is ${formatMathAnswer(answer)} cm3.`,
    })
  }
  const x = pickOne(rng, [4, 5, 6, 7, 8, 9])
  const offset = pickOne(rng, [2, 3, 4, 5])
  const total = 2 * (x - offset) + 5
  return createMathTask({
    id: buildTaskSeed(snapshot, phase, safeLevel, safeDomain, position, safeDifficulty),
    level: safeLevel,
    difficulty: safeDifficulty,
    domain: safeDomain,
    phase,
    prompt: `Los op: 2(x - ${offset}) + 5 = ${total}. Wat is x?`,
    answer: x,
    hint: "Werk terug in omgekeerde volgorde.",
    explanation: `Haal 5 eraf, deel door 2 en tel ${offset} erbij op. Dan krijg je ${x}.`,
  })
}

function buildLevelIntakeTasks(level, count, baseDifficulty, snapshot) {
  return Array.from({ length: count }, (_, index) => {
    const domain = MATH_DOMAINS[index % MATH_DOMAINS.length]
    const difficulty = clampMathDifficulty(baseDifficulty + Math.floor(index / MATH_DOMAINS.length))
    return generateTaskForLevel(level, difficulty, domain, snapshot, index, "intake")
  })
}

function buildIntakePlan(selectedBand, snapshot) {
  const safeBand = normalizeMathLevel(selectedBand)
  const bandIndex = mathLevelIndex(safeBand)
  const previousLevel = MATH_LEVELS[Math.max(0, bandIndex - 1)]
  const nextLevel = MATH_LEVELS[Math.min(MATH_LEVELS.length - 1, bandIndex + 1)]

  if (bandIndex === 0) {
    return [...buildLevelIntakeTasks("0f", 8, 1, snapshot), ...buildLevelIntakeTasks("1f", 8, 2, snapshot)]
  }
  if (bandIndex === MATH_LEVELS.length - 1) {
    return [...buildLevelIntakeTasks(previousLevel, 8, 2, snapshot), ...buildLevelIntakeTasks("4f", 8, 3, snapshot)]
  }
  return [
    ...buildLevelIntakeTasks(previousLevel, 4, 1, snapshot),
    ...buildLevelIntakeTasks(safeBand, 8, 2, snapshot),
    ...buildLevelIntakeTasks(nextLevel, 4, 3, snapshot),
  ]
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

function collectDomainStats(snapshot) {
  const stats = new Map(MATH_DOMAINS.map((domain) => [domain, { total: 0, correct: 0, recentTotal: 0, recentCorrect: 0 }]))

  for (const entry of snapshot.intakeAnswers || []) {
    const domain = MATH_DOMAINS.includes(entry.domain) ? entry.domain : "getallen"
    const bucket = stats.get(domain)
    bucket.total += 1
    if (entry.correct) bucket.correct += 1
  }

  const history = Array.isArray(snapshot.practiceHistory) ? snapshot.practiceHistory : []
  for (const entry of history) {
    const domain = MATH_DOMAINS.includes(entry.domain) ? entry.domain : "getallen"
    const bucket = stats.get(domain)
    bucket.total += 1
    if (entry.correct) bucket.correct += 1
  }

  for (const entry of history.slice(-6)) {
    const domain = MATH_DOMAINS.includes(entry.domain) ? entry.domain : "getallen"
    const bucket = stats.get(domain)
    bucket.recentTotal += 1
    if (entry.correct) bucket.recentCorrect += 1
  }

  return stats
}

function getFocusDomains(snapshot) {
  const stats = collectDomainStats(snapshot)
  return MATH_DOMAINS.map((domain) => {
    const bucket = stats.get(domain)
    const accuracy = bucket.total ? bucket.correct / bucket.total : 0.35
    const recentAccuracy = bucket.recentTotal ? bucket.recentCorrect / bucket.recentTotal : accuracy
    const score = accuracy * 0.55 + recentAccuracy * 0.45 - (bucket.recentTotal === 0 ? 0.08 : 0)
    return { domain, score }
  })
    .sort((left, right) => left.score - right.score)
    .slice(0, 2)
    .map((entry) => entry.domain)
}

function determinePlacement(snapshot) {
  const attemptedLevels = new Map()
  for (const answer of snapshot.intakeAnswers || []) {
    const level = normalizeMathLevel(answer.level)
    const bucket = attemptedLevels.get(level) || { total: 0, correct: 0, domains: new Map() }
    bucket.total += 1
    if (answer.correct) bucket.correct += 1
    const domainKey = MATH_DOMAINS.includes(answer.domain) ? answer.domain : "getallen"
    const domainBucket = bucket.domains.get(domainKey) || { total: 0, correct: 0 }
    domainBucket.total += 1
    if (answer.correct) domainBucket.correct += 1
    bucket.domains.set(domainKey, domainBucket)
    attemptedLevels.set(level, bucket)
  }

  const attemptedOrder = [...attemptedLevels.keys()].sort((left, right) => mathLevelIndex(left) - mathLevelIndex(right))
  let placement = attemptedOrder[0] || normalizeMathLevel(snapshot.selectedBand)

  for (const level of attemptedOrder) {
    const bucket = attemptedLevels.get(level)
    if (!bucket?.total) continue
    const overallRate = bucket.correct / bucket.total
    const overallThreshold = bucket.total >= 8 ? 0.75 : 1
    const hasBroadCoverage =
      bucket.total >= 8
        ? MATH_DOMAINS.every((domain) => {
            const domainBucket = bucket.domains.get(domain)
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

function updateDifficulty(snapshot, correct) {
  const currentDifficulty = clampMathDifficulty(snapshot.practiceDifficulty || 2)
  const currentStreak = Number(snapshot.streak) || 0
  const nextStreak = correct ? Math.max(1, currentStreak + 1) : Math.min(-1, currentStreak - 1)

  let nextDifficulty = currentDifficulty
  if (nextStreak >= 2) nextDifficulty = clampMathDifficulty(currentDifficulty + 1)
  if (nextStreak <= -2) nextDifficulty = clampMathDifficulty(currentDifficulty - 1)

  snapshot.practiceDifficulty = nextDifficulty
  snapshot.streak = Math.abs(nextStreak) >= 2 ? 0 : nextStreak
}

function buildCurrentTask(snapshot) {
  if (snapshot.awaitingNext) return null

  if (snapshot.phase === "intake") {
    return buildIntakePlan(snapshot.selectedBand, snapshot)[snapshot.intakeIndex] || null
  }

  const focusDomains = snapshot.focusDomains?.length ? snapshot.focusDomains : getFocusDomains(snapshot)
  const preferredDomain = focusDomains[0] || "getallen"
  return generateTaskForLevel(
    snapshot.targetLevel || getNextMathLevel(snapshot.placementLevel || snapshot.selectedBand),
    snapshot.practiceDifficulty || 2,
    preferredDomain,
    snapshot,
    snapshot.practiceQuestionCount || 0,
    "practice"
  )
}

function hydrateSnapshot(rawSnapshot) {
  if (!rawSnapshot) return null
  const snapshot = {
    version: 1,
    key: rawSnapshot.key,
    name: rawSnapshot.name || "",
    learnerCode: normalizeLearnerCode(rawSnapshot.learnerCode),
    roomCode: String(rawSnapshot.roomCode || "").trim().toUpperCase(),
    savedAt: rawSnapshot.savedAt || new Date().toISOString(),
    assignmentTitle: String(rawSnapshot.assignmentTitle || rawSnapshot.title || "").trim(),
    dueAt: String(rawSnapshot.dueAt || "").trim(),
    selectedBand: normalizeMathLevel(rawSnapshot.selectedBand),
    phase: rawSnapshot.phase === "practice" ? "practice" : "intake",
    intakeIndex: Number(rawSnapshot.intakeIndex) || 0,
    intakeTotal: Number(rawSnapshot.intakeTotal) || 16,
    intakeAnswers: Array.isArray(rawSnapshot.intakeAnswers)
      ? rawSnapshot.intakeAnswers.map((entry) => ({
          level: normalizeMathLevel(entry.level),
          domain: MATH_DOMAINS.includes(entry.domain) ? entry.domain : "",
          correct: Boolean(entry.correct),
        }))
      : [],
    practiceHistory: Array.isArray(rawSnapshot.practiceHistory)
      ? rawSnapshot.practiceHistory.map((entry) => ({
          domain: MATH_DOMAINS.includes(entry.domain) ? entry.domain : "",
          correct: Boolean(entry.correct),
          difficulty: clampMathDifficulty(entry.difficulty),
        }))
      : [],
    placementLevel: rawSnapshot.placementLevel ? normalizeMathLevel(rawSnapshot.placementLevel) : "",
    targetLevel: rawSnapshot.targetLevel ? normalizeMathLevel(rawSnapshot.targetLevel) : "",
    practiceDifficulty: clampMathDifficulty(rawSnapshot.practiceDifficulty || 2),
    streak: Number(rawSnapshot.streak) || 0,
    answeredCount: Number(rawSnapshot.answeredCount) || 0,
    correctCount: Number(rawSnapshot.correctCount) || 0,
    wrongCount: Number(rawSnapshot.wrongCount) || 0,
    practiceQuestionCount: Number(rawSnapshot.practiceQuestionCount) || 0,
    practiceCorrectCount: Number(rawSnapshot.practiceCorrectCount) || 0,
    focusDomains: Array.isArray(rawSnapshot.focusDomains)
      ? rawSnapshot.focusDomains.filter((domain) => MATH_DOMAINS.includes(domain))
      : [],
    awaitingNext: Boolean(rawSnapshot.awaitingNext),
    lastResult: rawSnapshot.lastResult || null,
    intakeRetryTaskId: String(rawSnapshot.intakeRetryTaskId || ""),
    growthSummary: rawSnapshot.growthSummary || null,
    source: "local-home",
  }

  snapshot.focusDomains = snapshot.focusDomains.length ? snapshot.focusDomains : getFocusDomains(snapshot)
  snapshot.currentTask = buildCurrentTask(snapshot)
  return snapshot
}

export function readHomeMathSnapshot(name = "", learnerCode = "") {
  const key = buildSnapshotKey(name, learnerCode)
  if (!key || key === "::") return null
  const store = readStore()
  return store[key] ? hydrateSnapshot(store[key]) : null
}

function saveSnapshot(snapshot) {
  const store = readStore()
  const savedSnapshot = {
    ...snapshot,
    currentTask: null,
    savedAt: new Date().toISOString(),
  }
  store[snapshot.key] = savedSnapshot
  writeStore(store)
  return hydrateSnapshot(savedSnapshot)
}

export function writeHomeMathSnapshotFromServer({ name = "", learnerCode = "", roomCode = "", math }) {
  const key = buildSnapshotKey(name, learnerCode)
  if (!key || !math) return null

  return saveSnapshot({
    version: 1,
    key,
    name: String(name || "").trim(),
    learnerCode: normalizeLearnerCode(learnerCode),
    roomCode: String(roomCode || "").trim().toUpperCase(),
    assignmentTitle: String(math.assignmentTitle || math.title || "").trim(),
    dueAt: String(math.dueAt || "").trim(),
    selectedBand: normalizeMathLevel(math.selectedBand),
    phase: math.phase === "practice" ? "practice" : "intake",
    intakeIndex: Number(math.intakeIndex) || 0,
    intakeTotal: Number(math.intakeTotal) || 16,
    intakeAnswers: Array.isArray(math.intakeAnswers) ? math.intakeAnswers : [],
    practiceHistory: Array.isArray(math.practiceHistory) ? math.practiceHistory : [],
    placementLevel: math.placementLevel ? normalizeMathLevel(math.placementLevel) : "",
    targetLevel: math.targetLevel ? normalizeMathLevel(math.targetLevel) : "",
    practiceDifficulty: clampMathDifficulty(math.practiceDifficulty || 2),
    streak: Number(math.streak) || 0,
    answeredCount: Number(math.answeredCount) || 0,
    correctCount: Number(math.correctCount) || 0,
    wrongCount: Number(math.wrongCount) || 0,
    practiceQuestionCount: Number(math.practiceQuestionCount) || 0,
    practiceCorrectCount: Number(math.practiceCorrectCount) || 0,
    focusDomains: Array.isArray(math.focusDomains) ? math.focusDomains.map((domain) => String(domain).toLowerCase()) : [],
    awaitingNext: Boolean(math.awaitingNext),
    lastResult: math.lastResult
      ? {
          ...math.lastResult,
          placementLevel: math.lastResult.placementLevel ? normalizeMathLevel(math.lastResult.placementLevel) : "",
          targetLevel: math.lastResult.targetLevel ? normalizeMathLevel(math.lastResult.targetLevel) : "",
        }
      : null,
    growthSummary: math.growthSummary || null,
    intakeRetryTaskId: "",
  })
}

function buildUiState(snapshot) {
  const currentTask = snapshot.currentTask
    ? {
        id: snapshot.currentTask.id,
        prompt: snapshot.currentTask.prompt,
        domain: snapshot.currentTask.domain,
        level: snapshot.currentTask.level.toUpperCase(),
        difficulty: snapshot.currentTask.difficulty,
        hint: snapshot.currentTask.hint,
        phase: snapshot.currentTask.phase,
      }
    : null

  return {
    title: snapshot.assignmentTitle || `Thuisroute ${snapshot.selectedBand.toUpperCase()}`,
    assignmentTitle: snapshot.assignmentTitle || "",
    dueAt: snapshot.dueAt || "",
    selectedBand: snapshot.selectedBand.toUpperCase(),
    learnerCode: snapshot.learnerCode,
    phase: snapshot.phase,
    intakeIndex: snapshot.intakeIndex,
    intakeTotal: snapshot.intakeTotal,
    intakeAnswers: snapshot.intakeAnswers,
    placementLevel: snapshot.placementLevel ? snapshot.placementLevel.toUpperCase() : "",
    targetLevel: snapshot.targetLevel ? snapshot.targetLevel.toUpperCase() : "",
    practiceDifficulty: snapshot.practiceDifficulty,
    streak: snapshot.streak,
    answeredCount: snapshot.answeredCount,
    correctCount: snapshot.correctCount,
    wrongCount: snapshot.wrongCount,
    accuracyRate: snapshot.answeredCount ? Math.round((snapshot.correctCount / snapshot.answeredCount) * 100) : 0,
    practiceQuestionCount: snapshot.practiceQuestionCount,
    practiceCorrectCount: snapshot.practiceCorrectCount,
    focusDomains: snapshot.focusDomains,
    currentTask,
    awaitingNext: snapshot.awaitingNext,
    lastResult: snapshot.lastResult
      ? {
          ...snapshot.lastResult,
          placementLevel: snapshot.lastResult.placementLevel ? snapshot.lastResult.placementLevel.toUpperCase() : "",
          targetLevel: snapshot.lastResult.targetLevel ? snapshot.lastResult.targetLevel.toUpperCase() : "",
        }
      : null,
    growthSummary: snapshot.growthSummary || null,
    source: "local-home",
  }
}

export function activateHomeMathSnapshot(snapshot) {
  const hydrated = hydrateSnapshot(snapshot)
  return hydrated ? buildUiState(hydrated) : null
}

function mutateSnapshotFromUiState(uiState) {
  return hydrateSnapshot({
    ...uiState,
    selectedBand: uiState.selectedBand,
    placementLevel: uiState.placementLevel,
    targetLevel: uiState.targetLevel,
  })
}

export function submitHomeMathAnswer(uiState, rawAnswer) {
  const snapshot = mutateSnapshotFromUiState(uiState)
  if (!snapshot?.currentTask || snapshot.awaitingNext) return buildUiState(snapshot)

  const task = snapshot.currentTask
  const candidate = parseMathAnswer(rawAnswer)
  const correct = candidate !== null && Math.abs(candidate - task.answer) <= Math.max(0, Number(task.tolerance) || 0)
  const expectedAnswer = formatMathAnswer(task.answer)
  const answeredValue = candidate === null ? String(rawAnswer ?? "").trim() : formatMathAnswer(candidate)
  const explanation = buildChildFriendlyMathExplanation(task, expectedAnswer)

  if (snapshot.phase === "intake") {
    const canRetry = !correct && snapshot.intakeRetryTaskId !== task.id
    if (canRetry) {
      snapshot.intakeRetryTaskId = task.id
      snapshot.lastResult = {
        phase: "intake-review",
        correct: false,
        expectedAnswer: "",
        answeredValue,
        explanation: task.hint ? `Tip: ${task.hint}` : "Kijk nog eens rustig naar de som en reken hem opnieuw uit.",
        feedback: "Denk je dat je een tikfout maakte? Klik op 'Pas antwoord aan' en probeer deze vraag nog 1 keer.",
        canRetry: true,
      }
      return buildUiState(saveSnapshot(snapshot))
    }

    snapshot.intakeRetryTaskId = ""
    snapshot.intakeAnswers.push({
      level: task.level,
      domain: task.domain,
      correct,
    })
    snapshot.answeredCount += 1
    if (correct) snapshot.correctCount += 1
    else snapshot.wrongCount += 1

    const hasMoreIntakeQuestions = snapshot.intakeIndex + 1 < snapshot.intakeTotal
    if (hasMoreIntakeQuestions) {
      snapshot.intakeIndex += 1
      snapshot.awaitingNext = true
      snapshot.currentTask = null
      snapshot.lastResult = {
        phase: "intake",
        correct,
        expectedAnswer,
        answeredValue,
        explanation,
        feedback: correct
          ? "Goed gedaan. Dit antwoord klopt. Tik op 'Volgende vraag' om verder te gaan."
          : "Nog niet goed. Kijk rustig naar de uitleg hieronder en ga dan verder.",
      }
    } else {
      const placementLevel = determinePlacement(snapshot)
      const targetLevel = getNextMathLevel(placementLevel)
      snapshot.phase = "practice"
      snapshot.placementLevel = placementLevel
      snapshot.targetLevel = targetLevel
      snapshot.practiceDifficulty = Math.max(2, clampMathDifficulty(mathLevelIndex(targetLevel) + 1))
      snapshot.awaitingNext = true
      snapshot.currentTask = null
      snapshot.lastResult = {
        phase: "placement",
        correct,
        expectedAnswer,
        answeredValue,
        explanation,
        placementLevel,
        targetLevel,
        feedback: `Instaptoets klaar. Jij laat nu ${placementLevel.toUpperCase()} zien en gaat oefenen op ${targetLevel.toUpperCase()}.`,
      }
    }
    snapshot.focusDomains = getFocusDomains(snapshot)
    return buildUiState(saveSnapshot(snapshot))
  }

  snapshot.answeredCount += 1
  snapshot.practiceQuestionCount += 1
  if (correct) {
    snapshot.correctCount += 1
    snapshot.practiceCorrectCount += 1
  } else {
    snapshot.wrongCount += 1
  }
  snapshot.practiceHistory.push({
    domain: task.domain,
    correct,
    difficulty: task.difficulty,
  })
  updateDifficulty(snapshot, correct)
  snapshot.focusDomains = getFocusDomains(snapshot)
  snapshot.awaitingNext = true
  snapshot.currentTask = null
  snapshot.lastResult = {
    phase: "practice",
    correct,
    expectedAnswer,
    answeredValue,
    explanation,
    placementLevel: snapshot.placementLevel,
    targetLevel: snapshot.targetLevel,
    feedback: correct
      ? `Goed! De volgende som past weer bij ${snapshot.targetLevel.toUpperCase()}.`
      : "Dat antwoord klopt nog niet. Kijk rustig naar de uitleg hieronder. Daarna krijg je een nieuwe som.",
  }
  return buildUiState(saveSnapshot(snapshot))
}

export function retryHomeMathIntake(uiState) {
  const snapshot = mutateSnapshotFromUiState(uiState)
  if (!snapshot?.lastResult?.canRetry) return buildUiState(snapshot)
  snapshot.lastResult = null
  snapshot.awaitingNext = false
  snapshot.currentTask = buildCurrentTask(snapshot)
  return buildUiState(saveSnapshot(snapshot))
}

export function nextHomeMathTask(uiState) {
  const snapshot = mutateSnapshotFromUiState(uiState)
  snapshot.awaitingNext = false
  snapshot.lastResult = null
  snapshot.currentTask = buildCurrentTask(snapshot)
  return buildUiState(saveSnapshot(snapshot))
}
