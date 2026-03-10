import { useState } from "react";
import { io } from "socket.io-client";

const socket = io("http://localhost:3001");

function Join() {

  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  const joinGame = () => {

    if (!name || !code) {
      alert("Vul naam en spelcode in");
      return;
    }

    console.log("joining game", name, code);

    socket.emit("player:join", {
      name: name,
      code: code
    });

  };

  return (
    <div
      style={{
        fontFamily: "sans-serif",
        padding: "40px",
        background: "#111827",
        color: "white",
        minHeight: "100vh"
      }}
    >
      <h1>Join Lesson Battle</h1>

      <input
        placeholder="Naam"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      <br />
      <br />

      <input
        placeholder="Spelcode"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />

      <br />
      <br />

      <button onClick={joinGame}>
        Join game
      </button>

    </div>
  );
}

export default Join;