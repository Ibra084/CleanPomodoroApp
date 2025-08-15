import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play,
  Pause,
  RotateCcw,
  SkipForward,
  Settings,
  Bell,
  Volume2,
  VolumeX,
  Plus,
  Trash2,
  CheckCircle2,
  Timer as TimerIcon,
  Award,
  BarChart3,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

/**
 * Pomodoro Timer — Clean UI + Progress Tracking
 *
 * Features
 * - Focus / Short break / Long break with custom durations
 * - Auto-cycle with long-break interval
 * - Tasks with per-task Pomodoro counts
 * - Today totals, 7-day chart, and streaks
 * - LocalStorage persistence
 * - Optional sound + desktop notifications
 * - Keyboard shortcuts: [Space]=Start/Pause, N=Next, R=Reset
 * - Export history as CSV
 */

// -------------------- Utilities --------------------
const pad = (n) => String(n).padStart(2, "0");
const secondsToMMSS = (s) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
const todayKey = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const STORAGE_KEYS = {
  settings: "pomodoro.settings.v1",
  history: "pomodoro.history.v1",
  tasks: "pomodoro.tasks.v1",
  ui: "pomodoro.ui.v1",
};

function useLocalStorage(key, initial) {
  const [state, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : initial;
    } catch (e) {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {}
  }, [key, state]);
  return [state, setState];
}

function useInterval(callback, delay, active) {
  const savedRef = useRef(callback);
  useEffect(() => {
    savedRef.current = callback;
  }, [callback]);
  useEffect(() => {
    if (!active || delay == null) return;
    const id = setInterval(() => savedRef.current(), delay);
    return () => clearInterval(id);
  }, [delay, active]);
}

// Simple WebAudio beep (no external assets)
function beep(freq = 880, duration = 160) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + 0.02);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration / 1000);
    o.stop(ctx.currentTime + duration / 1000 + 0.01);
  } catch {}
}

// Request notification permission once
async function ensureNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission !== "denied") {
    const res = await Notification.requestPermission();
    return res === "granted";
  }
  return false;
}

// -------------------- Main Component --------------------
export default function PomodoroCanvas() {
  // Settings
  const [settings, setSettings] = useLocalStorage(STORAGE_KEYS.settings, {
    focusMin: 25,
    shortMin: 5,
    longMin: 15,
    longInterval: 4,
    autoStartNext: true,
    sound: true,
    notifications: false,
  });

  // UI prefs
  const [ui, setUi] = useLocalStorage(STORAGE_KEYS.ui, {
    showSettings: false,
    showTasks: true,
  });

  // Tasks
  const [tasks, setTasks] = useLocalStorage(STORAGE_KEYS.tasks, []);
  const [newTask, setNewTask] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState(() => tasks[0]?.id || null);
  useEffect(() => {
    if (tasks.length && !selectedTaskId) setSelectedTaskId(tasks[0].id);
  }, [tasks, selectedTaskId]);

  // History (array of sessions)
  const [history, setHistory] = useLocalStorage(STORAGE_KEYS.history, []);

  // Timer state
  const [mode, setMode] = useState(/** @type {"focus"|"short"|"long"} */ ("focus"));
  const [isRunning, setIsRunning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(settings.focusMin * 60);
  const [completedFocusBlocks, setCompletedFocusBlocks] = useState(0); // since last long break

  // When settings change, adjust remaining seconds only if not running
  useEffect(() => {
    if (isRunning) return;
    if (mode === "focus") setSecondsLeft(settings.focusMin * 60);
    if (mode === "short") setSecondsLeft(settings.shortMin * 60);
    if (mode === "long") setSecondsLeft(settings.longMin * 60);
  }, [settings.focusMin, settings.shortMin, settings.longMin, isRunning, mode]);

  // Core ticking
  useInterval(
    () => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          handleSessionEnd();
          return 0;
        }
        return s - 1;
      });
    },
    1000,
    isRunning
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
      if (e.code === "Space") {
        e.preventDefault();
        setIsRunning((r) => !r);
      } else if (e.code === "KeyN") {
        e.preventDefault();
        skipToNext();
      } else if (e.code === "KeyR") {
        e.preventDefault();
        resetTimer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, secondsLeft, isRunning]);

  // Notify on mode changes end/start
  useEffect(() => {
    document.title = `${modeTitle(mode)} • ${secondsToMMSS(secondsLeft)} — Pomodoro`;
  }, [mode, secondsLeft]);

  function modeTitle(m) {
    return m === "focus" ? "Focus" : m === "short" ? "Short Break" : "Long Break";
  }

  function startTimer() {
    setIsRunning(true);
  }
  function pauseTimer() {
    setIsRunning(false);
  }
  function resetTimer(nextMode = mode) {
    setIsRunning(false);
    if (nextMode === "focus") setSecondsLeft(settings.focusMin * 60);
    if (nextMode === "short") setSecondsLeft(settings.shortMin * 60);
    if (nextMode === "long") setSecondsLeft(settings.longMin * 60);
    setMode(nextMode);
  }

  function skipToNext() {
    setIsRunning(false);
    handleSessionEnd(true); // mark as ended and jump
  }

  async function handleSessionEnd(skip = false) {
    // Record session
    const planned = mode === "focus" ? settings.focusMin * 60 : mode === "short" ? settings.shortMin * 60 : settings.longMin * 60;
    const actual = planned - secondsLeft;
    if (actual > 0) {
      const entry = {
        id: crypto.randomUUID(),
        date: new Date().toISOString(),
        mode,
        seconds: actual,
        taskId: mode === "focus" ? selectedTaskId : null,
      };
      setHistory((h) => pruneOld([...h, entry]));
      if (mode === "focus" && selectedTaskId) {
        setTasks((ts) => ts.map((t) => (t.id === selectedTaskId ? { ...t, pomodoros: (t.pomodoros || 0) + 1 } : t)));
      }
    }

    if (settings.sound) beep(750, 180);
    if (settings.notifications && (await ensureNotificationPermission())) {
      const body = mode === "focus" ? "Focus block complete. Take a break!" : "Break over. Back to focus.";
      new Notification("Pomodoro", { body });
    }

    // Choose next mode
    if (mode === "focus") {
      const nextIsLong = (completedFocusBlocks + 1) % clamp(settings.longInterval, 2, 12) === 0;
      setCompletedFocusBlocks((n) => n + 1);
      const nextMode = nextIsLong ? "long" : "short";
      setMode(nextMode);
      setSecondsLeft(nextIsLong ? settings.longMin * 60 : settings.shortMin * 60);
      setIsRunning(settings.autoStartNext && !skip);
    } else {
      // from any break -> focus
      setMode("focus");
      setSecondsLeft(settings.focusMin * 60);
      setIsRunning(settings.autoStartNext && !skip);
    }
  }

  function pruneOld(arr) {
    // keep last 90 days
    const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
    return arr.filter((e) => new Date(e.date).getTime() >= cutoff);
  }

  // Progress ring
  const totalSeconds = mode === "focus" ? settings.focusMin * 60 : mode === "short" ? settings.shortMin * 60 : settings.longMin * 60;
  const progress = 1 - secondsLeft / Math.max(1, totalSeconds);

  // Aggregations
  const today = todayKey();
  const { todayFocusMin, todayBlocks } = useMemo(() => {
    const tEntries = history.filter((h) => h.date.slice(0, 10) === today && h.mode === "focus");
    const secs = tEntries.reduce((a, b) => a + b.seconds, 0);
    return { todayFocusMin: Math.round(secs / 60), todayBlocks: tEntries.length };
  }, [history]);

  const streak = useMemo(() => computeStreak(history), [history]);

  const chartData = useMemo(() => build7DayChart(history), [history]);

  // -------------- Tasks --------------
  function addTask() {
    const title = newTask.trim();
    if (!title) return;
    const task = { id: crypto.randomUUID(), title, pomodoros: 0, done: false };
    setTasks((t) => [task, ...t]);
    setNewTask("");
    if (!selectedTaskId) setSelectedTaskId(task.id);
  }
  function toggleTaskDone(id) {
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  }
  function removeTask(id) {
    setTasks((ts) => ts.filter((t) => t.id !== id));
    if (selectedTaskId === id) setSelectedTaskId(null);
  }

  // -------------- Export --------------
  function exportCSV() {
    const headers = ["id", "date", "mode", "seconds", "taskId"]; 
    const rows = [headers.join(",")].concat(
      history.map((h) => [h.id, h.date, h.mode, h.seconds, h.taskId || ""].join(","))
    );
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pomodoro_history_${today}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // -------------- Presets --------------
  function applyPreset(focus, short, long, interval) {
    setSettings((s) => ({ ...s, focusMin: focus, shortMin: short, longMin: long, longInterval: interval }));
    resetTimer("focus");
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-white to-slate-50 text-slate-900 p-4 md:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <motion.div initial={{ rotate: -5, scale: 0.9 }} animate={{ rotate: 0, scale: 1 }} className="p-2 rounded-2xl bg-red-500 text-white shadow">
              <TimerIcon className="h-5 w-5" />
            </motion.div>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold">Pomodoro Tracker</h1>
              <p className="text-sm text-slate-500">Clean timer • Progress tracking • Built for deep focus</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" className="rounded-2xl" onClick={() => setUi((u) => ({ ...u, showSettings: !u.showSettings }))}>
              <Settings className="h-4 w-4 mr-2" /> Settings {ui.showSettings ? <ChevronUp className="h-4 w-4 ml-1"/> : <ChevronDown className="h-4 w-4 ml-1"/>}
            </Button>
            <Button variant="secondary" className="rounded-2xl" onClick={exportCSV}>
              <BarChart3 className="h-4 w-4 mr-2"/> Export CSV
            </Button>
          </div>
        </div>

        {/* Settings Panel */}
        <AnimatePresence initial={false}>
          {ui.showSettings && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <Card className="rounded-2xl shadow-sm">
                <CardContent className="p-4 md:p-6 grid md:grid-cols-3 gap-6">
                  <div className="space-y-2">
                    <Label>Focus minutes</Label>
                    <Input type="number" min={1} max={180} value={settings.focusMin} onChange={(e) => setSettings((s) => ({ ...s, focusMin: clamp(parseInt(e.target.value || "0"), 1, 180) }))} />
                    <Label>Short break minutes</Label>
                    <Input type="number" min={1} max={60} value={settings.shortMin} onChange={(e) => setSettings((s) => ({ ...s, shortMin: clamp(parseInt(e.target.value || "0"), 1, 60) }))} />
                  </div>
                  <div className="space-y-2">
                    <Label>Long break minutes</Label>
                    <Input type="number" min={5} max={90} value={settings.longMin} onChange={(e) => setSettings((s) => ({ ...s, longMin: clamp(parseInt(e.target.value || "0"), 1, 90) }))} />
                    <Label>Long break every … focus blocks</Label>
                    <Input type="number" min={2} max={12} value={settings.longInterval} onChange={(e) => setSettings((s) => ({ ...s, longInterval: clamp(parseInt(e.target.value || "0"), 2, 12) }))} />
                  </div>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2"><Bell className="h-4 w-4"/><Label className="cursor-pointer">Desktop notifications</Label></div>
                      <Switch checked={settings.notifications} onCheckedChange={async (v) => {
                        if (v) {
                          const ok = await ensureNotificationPermission();
                          setSettings((s) => ({ ...s, notifications: ok }));
                        } else setSettings((s) => ({ ...s, notifications: false }));
                      }} />
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2"><Volume2 className="h-4 w-4"/><Label className="cursor-pointer">Sound</Label></div>
                      <Switch checked={settings.sound} onCheckedChange={(v) => setSettings((s) => ({ ...s, sound: v }))} />
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4"/><Label className="cursor-pointer">Auto-start next block</Label></div>
                      <Switch checked={settings.autoStartNext} onCheckedChange={(v) => setSettings((s) => ({ ...s, autoStartNext: v }))} />
                    </div>
                    <div className="pt-2">
                      <Label className="text-xs uppercase tracking-wide text-slate-500">Presets</Label>
                      <div className="mt-2 grid grid-cols-3 gap-2">
                        <Button variant="outline" className="rounded-xl" onClick={() => applyPreset(25,5,15,4)}>25/5/15</Button>
                        <Button variant="outline" className="rounded-xl" onClick={() => applyPreset(50,10,20,3)}>50/10/20</Button>
                        <Button variant="outline" className="rounded-xl" onClick={() => applyPreset(60,10,30,3)}>60/10/30</Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main Grid */}
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Timer Card */}
          <Card className="rounded-3xl shadow-sm lg:col-span-2">
            <CardContent className="p-6">
              <div className="flex flex-col md:flex-row gap-6">
                {/* Big timer + ring */}
                <div className="flex-1 flex flex-col items-center justify-center">
                  <div className="text-sm font-medium text-slate-500 mb-2">{modeTitle(mode)}</div>
                  <div className="relative h-56 w-56">
                    <svg className="absolute inset-0" viewBox="0 0 120 120">
                      <circle cx="60" cy="60" r="54" stroke="#e2e8f0" strokeWidth="10" fill="none" />
                      <circle
                        cx="60" cy="60" r="54" fill="none" stroke="currentColor" strokeWidth="10"
                        strokeLinecap="round"
                        strokeDasharray={`${Math.max(1, 2 * Math.PI * 54)}`}
                        strokeDashoffset={`${(1 - progress) * (2 * Math.PI * 54)}`}
                        className="text-red-500 transition-[stroke-dashoffset] duration-1000 ease-linear"
                        transform="rotate(-90 60 60)"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="text-5xl md:text-6xl font-bold tabular-nums">{secondsToMMSS(secondsLeft)}</div>
                    </div>
                  </div>
                  <div className="mt-4 flex items-center gap-2">
                    {!isRunning ? (
                      <Button className="rounded-2xl px-6" onClick={startTimer}>
                        <Play className="h-4 w-4 mr-2"/> Start (Space)
                      </Button>
                    ) : (
                      <Button variant="secondary" className="rounded-2xl px-6" onClick={pauseTimer}>
                        <Pause className="h-4 w-4 mr-2"/> Pause (Space)
                      </Button>
                    )}
                    <Button variant="ghost" className="rounded-2xl" onClick={() => resetTimer()}>
                      <RotateCcw className="h-4 w-4 mr-2"/> Reset (R)
                    </Button>
                    <Button variant="ghost" className="rounded-2xl" onClick={skipToNext}>
                      <SkipForward className="h-4 w-4 mr-2"/> Next (N)
                    </Button>
                  </div>
                  <div className="mt-3 text-xs text-slate-500">
                    Long break in <span className="font-semibold">{settings.longInterval - (completedFocusBlocks % settings.longInterval)}</span> focus block(s)
                  </div>
                </div>

                {/* Side stats */}
                <div className="w-full md:w-64 space-y-4">
                  <div className="rounded-2xl p-4 bg-slate-50 border border-slate-200">
                    <div className="flex items-center justify-between text-sm text-slate-600">
                      <span>Today focus</span>
                      <Award className="h-4 w-4"/>
                    </div>
                    <div className="mt-2 text-3xl font-bold">{todayFocusMin} min</div>
                    <div className="text-xs text-slate-500">{todayBlocks} block{todayBlocks === 1 ? "" : "s"}</div>
                  </div>
                  <div className="rounded-2xl p-4 bg-slate-50 border border-slate-200">
                    <div className="flex items-center justify-between text-sm text-slate-600">
                      <span>Streak</span>
                      <CheckCircle2 className="h-4 w-4"/>
                    </div>
                    <div className="mt-2 text-3xl font-bold">{streak} day{streak === 1 ? "" : "s"}</div>
                    <div className="text-xs text-slate-500">Consecutive days with focus</div>
                  </div>
                </div>
              </div>

              {/* Chart */}
              <div className="mt-6">
                <div className="flex items-center gap-2 mb-2 text-slate-600 text-sm"><BarChart3 className="h-4 w-4"/> Last 7 days (focus minutes)</div>
                <div className="h-48 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="day" />
                      <YAxis allowDecimals={false} />
                      <Tooltip formatter={(v) => `${v} min`} />
                      <Bar dataKey="minutes" radius={[8,8,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Tasks */}
          <Card className="rounded-3xl shadow-sm">
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 text-slate-700"><TimerIcon className="h-4 w-4"/> Tasks</div>
                <Switch checked={ui.showTasks} onCheckedChange={(v) => setUi((u) => ({ ...u, showTasks: v }))} />
              </div>
              <AnimatePresence initial={false}>
                {ui.showTasks && (
                  <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}>
                    <div className="flex gap-2 mb-4">
                      <Input placeholder="Add a task…" value={newTask} onChange={(e) => setNewTask(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTask()} />
                      <Button className="rounded-2xl" onClick={addTask}><Plus className="h-4 w-4"/></Button>
                    </div>
                    <div className="space-y-2 max-h-72 overflow-auto pr-1">
                      {tasks.length === 0 && (
                        <div className="text-sm text-slate-500">No tasks yet. Add one and select it to tie focus blocks.</div>
                      )}
                      {tasks.map((t) => (
                        <div key={t.id} className={`flex items-center gap-2 p-3 rounded-xl border ${selectedTaskId === t.id ? "border-red-300 bg-red-50" : "border-slate-200"}`}>
                          <button
                            className={`h-4 w-4 rounded border flex items-center justify-center ${t.done ? "bg-green-500 border-green-500" : "border-slate-300"}`}
                            onClick={() => toggleTaskDone(t.id)}
                            aria-label="Toggle done"
                          >
                            {t.done && <CheckCircle2 className="h-3 w-3 text-white"/>}
                          </button>
                          <button className="flex-1 text-left" onClick={() => setSelectedTaskId(t.id)}>
                            <div className={`text-sm ${t.done ? "line-through text-slate-400" : "text-slate-800"}`}>{t.title}</div>
                            <div className="text-xs text-slate-500">{t.pomodoros || 0} pomodoro{(t.pomodoros || 0) === 1 ? "" : "s"}</div>
                          </button>
                          <Button variant="ghost" size="sm" className="rounded-xl" onClick={() => removeTask(t.id)} aria-label="Delete"><Trash2 className="h-4 w-4"/></Button>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Task binding hint */}
              <div className="mt-4 text-xs text-slate-500">
                Selected task: {tasks.find((t) => t.id === selectedTaskId)?.title || <span className="italic">None</span>}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Footer tips */}
        <div className="text-xs text-slate-500 flex flex-col md:flex-row items-start md:items-center justify-between gap-2">
          <div>
            Shortcuts: <span className="font-semibold">Space</span> start/pause • <span className="font-semibold">N</span> next • <span className="font-semibold">R</span> reset
          </div>
          <div className="opacity-80">Built for you — stay consistent and aim for 3–5 high-quality blocks daily.</div>
        </div>
      </div>
    </div>
  );
}

// -------------------- Helpers --------------------
function build7DayChart(history) {
  // Build last 7 days from oldest to newest
  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    days.push({ key: d.toISOString().slice(0, 10), label: d.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase() });
  }
  const map = Object.fromEntries(days.map((d) => [d.key, 0]));
  history.forEach((h) => {
    const key = h.date.slice(0, 10);
    if (h.mode === "focus" && key in map) map[key] += Math.round(h.seconds / 60);
  });
  return days.map((d) => ({ day: d.label, minutes: map[d.key] }));
}

function computeStreak(history) {
  if (!history.length) return 0;
  // get unique dates where focus > 0
  const byDate = new Map();
  history.forEach((h) => {
    const key = h.date.slice(0, 10);
    if (h.mode === "focus") byDate.set(key, (byDate.get(key) || 0) + h.seconds);
  });
  let streak = 0;
  const now = new Date();
  for (let i = 0; ; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const has = (byDate.get(key) || 0) > 0;
    if (has) streak++;
    else break;
  }
  return streak;
}
