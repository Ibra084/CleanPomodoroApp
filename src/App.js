import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Pomodoro from "./components/Pomodoro"; // adjust path if needed

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Pomodoro />} />
      </Routes>
    </Router>
  );
}