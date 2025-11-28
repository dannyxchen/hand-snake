import React, { useEffect, useRef, useState, useCallback } from 'react';
import { GameState, Direction, Position, MotionVector, ScoreEntry } from '../types';
import { detectMotion } from '../utils/visionUtils';

const INITIAL_SNAKE = [{ x: 10, y: 10 }];
const LEADERBOARD_KEY = 'neon_snake_leaderboard';
const BASE_SPEED = 250; // ms per frame (Slower start)
const SPEED_DECREMENT = 5; // ms faster per apple
const MIN_SPEED = 60; // Max speed cap

export const SnakeGame: React.FC = () => {
  // Game State
  const [gameState, setGameState] = useState<GameState>(GameState.IDLE);
  const [score, setScore] = useState(0); // For UI only
  const [countdown, setCountdown] = useState(0);
  const [isStarting, setIsStarting] = useState(false); // Prevents double clicks
  const [debugVector, setDebugVector] = useState<MotionVector>({ x: 0, y: 0, intensity: 0 });
  const [camError, setCamError] = useState<string | null>(null);
  
  // Player & Leaderboard State
  const [playerName, setPlayerName] = useState('');
  const [leaderboard, setLeaderboard] = useState<ScoreEntry[]>([]);

  // Refs for mutable game data (Sources of Truth for Game Loop)
  const snakeRef = useRef<Position[]>(INITIAL_SNAKE);
  const foodRef = useRef<Position>({ x: 15, y: 5 });
  const directionRef = useRef<Direction>(Direction.RIGHT);
  const scoreRef = useRef<number>(0); // Logic source of truth
  const gameLoopRef = useRef<number | null>(null);
  const lastUpdateRef = useRef<number>(0);
  const smoothedVectorRef = useRef<{x: number, y: number}>({x: 0, y:0});
  
  // HTML Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const motionCanvasRef = useRef<HTMLCanvasElement>(null);
  const gameCanvasRef = useRef<HTMLCanvasElement>(null);

  // Load Leaderboard on mount
  useEffect(() => {
    const saved = localStorage.getItem(LEADERBOARD_KEY);
    if (saved) {
        try {
            setLeaderboard(JSON.parse(saved));
        } catch (e) {
            console.error("Failed to parse leaderboard");
        }
    }

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                width: { ideal: 320 }, 
                height: { ideal: 240 },
                facingMode: 'user'
            } 
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          try {
            await videoRef.current.play();
          } catch (playErr) {
             console.error("Auto-play failed:", playErr);
          }
        }
      } catch (err) {
        console.error("Error accessing webcam:", err);
        setCamError("CAMERA ACCESS DENIED. PLEASE ALLOW CAMERA PERMISSIONS.");
      }
    };
    startCamera();

    return () => {
       if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current);
    };
  }, []);

  const saveScore = (finalScore: number) => {
      const entry: ScoreEntry = {
          name: playerName || 'Unknown Pilot',
          score: finalScore,
          timestamp: Date.now()
      };
      
      const newLeaderboard = [...leaderboard, entry]
        .sort((a, b) => b.score - a.score)
        .slice(0, 10); // Keep top 10
      
      setLeaderboard(newLeaderboard);
      localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(newLeaderboard));
  };

  // Actually start the game logic
  const startGame = useCallback(() => {
    setGameState(GameState.PLAYING);
    setScore(0);
    scoreRef.current = 0;
    snakeRef.current = [...INITIAL_SNAKE];
    directionRef.current = Direction.RIGHT;
    smoothedVectorRef.current = { x: 0, y: 0 };
    spawnFood();
    setIsStarting(false);
  }, []);

  // Revised Countdown Logic
  const startSequence = () => {
      if (!playerName.trim()) return;
      if (isStarting) return;

      setIsStarting(true);
      let count = 3;
      setCountdown(count);
      
      const interval = setInterval(() => {
          count--;
          if (count <= 0) {
              clearInterval(interval);
              setCountdown(0);
              startGame();
          } else {
              setCountdown(count);
          }
      }, 1000);
  };

  const spawnFood = () => {
    // Dynamic board size
    const cols = window.innerWidth < 640 ? 15 : 30;
    const rows = window.innerWidth < 640 ? 15 : 20;
    
    const x = Math.floor(Math.random() * (cols - 2)) + 1; 
    const y = Math.floor(Math.random() * (rows - 2)) + 1;
    foodRef.current = { x, y };
  };

  // The Main Loop
  const loop = useCallback((timestamp: number) => {
    if (gameState !== GameState.PLAYING) return;

    // 1. Handle Motion Detection
    if (videoRef.current && motionCanvasRef.current) {
        const ctx = motionCanvasRef.current.getContext('2d', { willReadFrequently: true });
        
        if (ctx && videoRef.current.readyState >= 2) {
            const w = motionCanvasRef.current.width;
            const h = motionCanvasRef.current.height;
            
            ctx.drawImage(videoRef.current, 0, 0, w, h);
            const rawVector = detectMotion(ctx, w, h);
            
            // Smoothing
            smoothedVectorRef.current.x = smoothedVectorRef.current.x * 0.8 + rawVector.x * 0.2;
            smoothedVectorRef.current.y = smoothedVectorRef.current.y * 0.8 + rawVector.y * 0.2;
            
            const smoothed = {
                x: smoothedVectorRef.current.x,
                y: smoothedVectorRef.current.y,
                intensity: rawVector.intensity
            };
            
            setDebugVector(smoothed);

            // Direction Logic
            const THRESHOLD = 0.3; 
            if (Math.abs(smoothed.x) > Math.abs(smoothed.y)) {
                if (Math.abs(smoothed.x) > THRESHOLD) {
                    const newDir = smoothed.x > 0 ? Direction.RIGHT : Direction.LEFT;
                    // Prevent 180 turns
                    if (
                        (newDir === Direction.RIGHT && directionRef.current !== Direction.LEFT) ||
                        (newDir === Direction.LEFT && directionRef.current !== Direction.RIGHT)
                    ) {
                        directionRef.current = newDir;
                    }
                }
            } else {
                if (Math.abs(smoothed.y) > THRESHOLD) {
                    const newDir = smoothed.y > 0 ? Direction.DOWN : Direction.UP;
                    if (
                        (newDir === Direction.DOWN && directionRef.current !== Direction.UP) ||
                        (newDir === Direction.UP && directionRef.current !== Direction.DOWN)
                    ) {
                        directionRef.current = newDir;
                    }
                }
            }
        }
    }

    // 2. Update Snake Logic (Variable Time Step based on Score)
    // Speed increases as score increases (Interval decreases)
    const currentSpeed = Math.max(MIN_SPEED, BASE_SPEED - (scoreRef.current * SPEED_DECREMENT));
    
    if (timestamp - lastUpdateRef.current > currentSpeed) {
        updateSnake();
        lastUpdateRef.current = timestamp;
    }

    // 3. Render Game
    renderGame();

    gameLoopRef.current = requestAnimationFrame(loop);
  }, [gameState]); // Dep only on gameState, internal state via Refs

  // Adjust Grid size based on screen
  const COLS = window.innerWidth < 640 ? 15 : 30;
  const ROWS = window.innerWidth < 640 ? 15 : 20;
  
  const updateSnake = () => {
    const head = { ...snakeRef.current[0] };

    switch (directionRef.current) {
        case Direction.UP: head.y -= 1; break;
        case Direction.DOWN: head.y += 1; break;
        case Direction.LEFT: head.x -= 1; break;
        case Direction.RIGHT: head.x += 1; break;
    }

    // Wall Collision
    if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) {
        gameOver();
        return;
    }

    // Self Collision
    if (snakeRef.current.some(segment => segment.x === head.x && segment.y === head.y)) {
        gameOver();
        return;
    }

    const newSnake = [head, ...snakeRef.current];

    // Food Collision
    if (head.x === foodRef.current.x && head.y === foodRef.current.y) {
        scoreRef.current += 1; // Update Ref for Logic
        setScore(scoreRef.current); // Update State for UI
        spawnFood();
    } else {
        newSnake.pop();
    }

    snakeRef.current = newSnake;
  };

  const gameOver = () => {
    setGameState(GameState.GAME_OVER);
    // Use the Ref value to ensure we have the latest score despite closure
    saveScore(scoreRef.current);
    if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current);
  };

  const renderGame = () => {
    const cvs = gameCanvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;

    // Clear
    ctx.clearRect(0, 0, cvs.width, cvs.height);

    const cellSize = cvs.width / COLS;

    // Draw Grid (Subtle)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for(let i=0; i<=COLS; i++) {
        ctx.moveTo(i*cellSize, 0); ctx.lineTo(i*cellSize, cvs.height);
    }
    for(let i=0; i<=ROWS; i++) {
        ctx.moveTo(0, i*cellSize); ctx.lineTo(cvs.width, i*cellSize);
    }
    ctx.stroke();

    // Draw Food
    ctx.fillStyle = '#ff0055';
    ctx.shadowBlur = 15;
    ctx.shadowColor = '#ff0055';
    const fx = foodRef.current.x * cellSize;
    const fy = foodRef.current.y * cellSize;
    
    // Pulsing effect for food
    const pulse = (Date.now() % 1000) / 1000; 
    const sizeMod = pulse * 4;
    ctx.fillRect(fx + 2 - sizeMod/2, fy + 2 - sizeMod/2, cellSize - 4 + sizeMod, cellSize - 4 + sizeMod);
    ctx.shadowBlur = 0;

    // Draw Snake
    snakeRef.current.forEach((seg, index) => {
        const x = seg.x * cellSize;
        const y = seg.y * cellSize;
        
        if (index === 0) {
            ctx.fillStyle = '#ffffff';
            ctx.shadowColor = '#00f2ff';
            ctx.shadowBlur = 20;
        } else {
            // Gradient effect along body
            ctx.fillStyle = `rgba(0, 242, 255, ${1 - index / (snakeRef.current.length + 8)})`;
            ctx.shadowBlur = 0;
        }
        
        ctx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
    });
    ctx.shadowBlur = 0;
  };

  // Start/Stop Loop
  useEffect(() => {
    if (gameState === GameState.PLAYING) {
        gameLoopRef.current = requestAnimationFrame(loop);
    }
    return () => {
        if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current);
    }
  }, [gameState, loop]);

  return (
    <div className="flex flex-col items-center justify-center retro-grid w-full h-screen relative">
      
      {/* Background Video Feed */}
      <video 
        ref={videoRef} 
        autoPlay 
        muted 
        playsInline 
        className="absolute inset-0 w-full h-full video-bg"
      />

      <canvas ref={motionCanvasRef} width={320} height={240} className="hidden" />

      {/* Main UI */}
      <div className="z-10 flex flex-col items-center gap-6 p-4 w-full" style={{ maxWidth: '800px' }}>
        
        {/* Header - Separate Glass Module */}
        <div className="flex justify-between items-center w-full glass-panel" style={{ padding: '12px 24px', borderRadius: '24px' }}>
            <div className="flex items-center gap-4">
                <div style={{ width: '44px', height: '44px', background: 'var(--color-primary)', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '900', color: '#000', fontSize: '1.2rem' }}>
                    {playerName ? playerName.charAt(0).toUpperCase() : '?'}
                </div>
                <div>
                    <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.6)', letterSpacing: '1px' }}>PILOT</div>
                    <div style={{ fontWeight: 'bold', color: '#fff', fontSize: '1.1rem' }}>{playerName || 'WAITING...'}</div>
                </div>
            </div>
            <div className="text-right">
                 <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.6)', letterSpacing: '1px' }}>SCORE</div>
                 <div className="neon-text" style={{ fontSize: '2.4rem', fontWeight: '900', lineHeight: 1, color: '#fff' }}>{score}</div>
            </div>
        </div>

        {/* Game Container - Separate Glass Module */}
        <div className="relative" style={{ display: 'inline-block' }}>
            <canvas 
                ref={gameCanvasRef} 
                width={Math.min(window.innerWidth - 32, 600)} 
                height={Math.min(window.innerWidth - 32, 600) * (ROWS/COLS)} 
                className="game-canvas"
            />
            
            {/* HUD: Joystick Radar (Visible when playing) */}
            {gameState === GameState.PLAYING && (
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                   
                   {/* Center Crosshair / Deadzone Ring */}
                   <div style={{
                       position: 'absolute',
                       width: '60px', height: '60px',
                       borderRadius: '50%',
                       border: '2px dashed rgba(255, 255, 255, 0.15)',
                       display: 'flex', alignItems: 'center', justifyContent: 'center'
                   }}>
                        <div style={{ width: '8px', height: '1px', background: 'rgba(255,255,255,0.3)' }}></div>
                        <div style={{ width: '1px', height: '8px', background: 'rgba(255,255,255,0.3)', position: 'absolute' }}></div>
                   </div>

                   {/* Active Motion Dot */}
                   <div 
                      style={{
                          position: 'absolute',
                          width: '18px', height: '18px',
                          borderRadius: '50%',
                          background: 'var(--color-primary)',
                          boxShadow: '0 0 15px var(--color-primary)',
                          transform: `translate(${debugVector.x * 100}px, ${debugVector.y * 100}px)`,
                          opacity: 0.9,
                          transition: 'transform 0.05s linear',
                      }}
                   />

                   <div style={{ 
                       position: 'absolute', 
                       bottom: 24, 
                       background: 'rgba(0,0,0,0.6)', 
                       padding: '6px 16px', 
                       borderRadius: '20px', 
                       border: '1px solid rgba(255,255,255,0.1)',
                       fontFamily: 'Orbitron', 
                       fontSize: '11px', 
                       color: 'var(--color-primary)',
                       letterSpacing: '2px',
                       backdropFilter: 'blur(4px)'
                   }}>
                       DIRECTION // {directionRef.current}
                   </div>
              </div>
            )}
                 
            {/* COUNTDOWN OVERLAY */}
            {countdown > 0 && (
                <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(8px)', zIndex: 50, borderRadius: '12px' }}>
                    <div className="neon-text" style={{ fontSize: '8rem', fontWeight: '900', color: '#fff' }}>
                        {countdown}
                    </div>
                </div>
            )}

            {/* MENU / START OVERLAY */}
            {gameState === GameState.IDLE && countdown === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ background: 'rgba(5, 5, 5, 0.65)', backdropFilter: 'blur(12px)', zIndex: 20, borderRadius: '12px' }}>
                    <div style={{ width: '100%', maxWidth: '320px', textAlign: 'center' }}>
                        <h1 className="text-title" style={{ marginBottom: '2rem', fontSize: '2.5rem' }}>NEON SNAKE</h1>
                        
                        {camError ? (
                             <div style={{ color: 'var(--color-accent)', border: '1px solid var(--color-accent)', padding: '15px', marginBottom: '20px', background: 'rgba(255,0,0,0.1)' }}>
                                {camError}
                             </div>
                        ) : (
                            <>
                                <div style={{ position: 'relative', marginBottom: '1.5rem' }}>
                                    <input 
                                        type="text" 
                                        value={playerName}
                                        onChange={(e) => setPlayerName(e.target.value)}
                                        className="cyber-input"
                                        placeholder="ENTER PILOT ID"
                                        maxLength={12}
                                    />
                                </div>
                                
                                <button 
                                    onClick={startSequence}
                                    disabled={!playerName.trim() || isStarting}
                                    className="cyber-btn"
                                >
                                    {isStarting ? 'INITIALIZING...' : 'START MISSION'}
                                </button>
                            </>
                        )}

                        <div style={{ marginTop: '2.5rem', fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1.5rem' }}>
                            <div className="flex justify-between" style={{ marginBottom: '8px' }}>
                                <span>CONTROL SYSTEM</span>
                                <span style={{ color: 'var(--color-primary)' }}>OPTICAL FLOW</span>
                            </div>
                            <div style={{ fontSize: '0.7rem', marginTop: '8px' }}>Move your body to steer the snake.</div>
                        </div>
                    </div>
                </div>
            )}

            {/* GAME OVER OVERLAY */}
            {gameState === GameState.GAME_OVER && (
                <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ background: 'rgba(5, 5, 5, 0.85)', backdropFilter: 'blur(10px)', zIndex: 30, borderRadius: '12px' }}>
                    <h2 style={{ fontFamily: 'Orbitron', fontSize: '3.5rem', margin: 0, color: 'var(--color-accent)', textShadow: '0 0 30px rgba(255,0,85,0.6)' }}>CRASHED</h2>
                    <div style={{ fontSize: '1.2rem', color: '#fff', marginBottom: '2rem', letterSpacing: '4px' }}>
                        FINAL SCORE: <span style={{ color: 'var(--color-primary)', fontWeight: 'bold' }}>{score}</span>
                    </div>
                    
                    <div className="glass-panel" style={{ width: '85%', maxWidth: '320px', padding: '1rem', marginBottom: '1.5rem', background: 'rgba(0,0,0,0.6)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px', fontSize: '0.8rem', color: '#888', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '4px' }}>
                            <span>PILOT</span>
                            <span>SCORE</span>
                        </div>
                        <div style={{ maxHeight: '160px', overflowY: 'auto', paddingRight: '4px' }}>
                            {leaderboard.map((entry, i) => (
                                <div key={entry.timestamp + i} className={`leaderboard-row ${entry.score === score && entry.name === playerName ? 'highlight' : ''}`}>
                                    <span>#{i+1} {entry.name}</span>
                                    <span>{entry.score}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <button 
                        onClick={startSequence}
                        disabled={isStarting}
                        className="cyber-btn"
                        style={{ width: 'auto', padding: '14px 40px' }}
                    >
                        REBOOT SYSTEM
                    </button>
                </div>
            )}
        </div>
      </div>
    </div>
  );
};