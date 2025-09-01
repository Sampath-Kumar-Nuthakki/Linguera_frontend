// Improved server.js with Python microservice integration
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const axios = require("axios");
const cors = require("cors");
const ExcelJS = require('exceljs');

// Configuration
const config = {
  port: process.env.PORT || 3000,
  pythonServiceUrl: process.env.PYTHON_SERVICE_URL || 'https://wipgenai.lwpcoe.com/linguera/',
  maxTranslationLength: parseInt(process.env.MAX_TRANSLATION_LENGTH) || 5000,
  maxRoomParticipants: parseInt(process.env.MAX_ROOM_PARTICIPANTS) || 2,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  cleanupInterval: 60000, // 1 minute
  transcriptRetentionHours: 24,
  translationTimeout: 30000 // 30 seconds timeout for translation requests
};

// Initialize Express app and server
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: config.corsOrigin } });

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Global state
const rooms = new Map();
const transcripts = new Map();
const agentAvailability = {};
let excludedWords = [];
let pythonServiceHealthy = false;

// File paths
const EXCLUDED_WORDS_FILE = path.join(__dirname, 'excludedWords.json');
const TRANSLATION_LOG_FILE = path.join(__dirname, 'translation_logs.json');

// Directory paths for organized storage
const TRANSLATION_LOGS_DIR = path.join(__dirname, 'translation-logs');
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');

// ================================
// UTILITY FUNCTIONS
// ================================

function normalizeText(text) {
  return text.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

function validateInput(text, maxLength = config.maxTranslationLength) {
  if (!text || typeof text !== 'string') {
    return { isValid: false, error: 'Text is required and must be a string' };
  }
  
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { isValid: false, error: 'Text cannot be empty' };
  }
  
  if (trimmed.length > maxLength) {
    return { isValid: false, error: `Text too long (max ${maxLength} characters)` };
  }
  
  return { isValid: true, text: trimmed };
}

// ================================
// PYTHON SERVICE COMMUNICATION
// ================================

async function checkPythonServiceHealth() {
  try {
    const response = await fetch(`${config.pythonServiceUrl}/health`, {
      method: 'GET',
      timeout: 5000
    });
    
    if (response.ok) {
      const health = await response.json();
      pythonServiceHealthy = health.model_loaded;
      console.log(`🐍 Python service health: ${pythonServiceHealthy ? 'healthy' : 'unhealthy'}`);
      return pythonServiceHealthy;
    }
    
    pythonServiceHealthy = false;
    return false;
    
  } catch (error) {
    console.error('🐍 Python service health check failed:', error.message);
    pythonServiceHealthy = false;
    return false;
  }
}

async function translateWithPythonService(text, sourceLang, targetLang) {
  try {
    const startTime = Date.now();
    
    const response = await fetch(`${config.pythonServiceUrl}/translate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
        source_lang: sourceLang,
        target_lang: targetLang
      }),
      timeout: config.translationTimeout
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(`Translation failed: ${errorData.detail || response.statusText}`);
    }

    const result = await response.json();
    const durationMs = Date.now() - startTime;
    
    console.log(`🐍 Translation completed: ${sourceLang} -> ${targetLang}, duration: ${durationMs}ms`);
    
    return {
      translatedText: result.translated_text,
      durationMs: durationMs,
      sentenceCount: result.sentence_count || 1
    };
    
  } catch (error) {
    console.error('🐍 Python service translation error:', error.message);
    throw error;
  }
}

// ================================
// DICTIONARY MANAGEMENT
// ================================

function loadExcludedWords() {
  try {
    if (fs.existsSync(EXCLUDED_WORDS_FILE)) {
      excludedWords = JSON.parse(fs.readFileSync(EXCLUDED_WORDS_FILE, 'utf8'));
      console.log(`📚 Loaded ${excludedWords.length} excluded words`);
    }
  } catch (error) {
    console.error('📚 Error loading excluded words:', error);
    excludedWords = [];
  }
}

function saveExcludedWords() {
  try {
    fs.writeFileSync(EXCLUDED_WORDS_FILE, JSON.stringify(excludedWords, null, 2), 'utf8');
    console.log(`📚 Saved ${excludedWords.length} excluded words`);
  } catch (error) {
    console.error('📚 Error saving excluded words:', error);
  }
}

function applyWordReplacements(text, targetLang) {
  if (!text || typeof text !== 'string') return text;
  let processedText = text;
  
  try {
    const validEntries = excludedWords.filter(entry => {
      const hasTargetLang = entry[targetLang]?.trim();
      const hasEnglish = entry.en?.trim();
      return hasTargetLang && hasEnglish;
    });
    
    // Sort by length descending for better matching
    const sortedWords = validEntries.sort((a, b) =>
      b[targetLang].trim().length - a[targetLang].trim().length
    );
    
    sortedWords.forEach((wordEntry) => {
      const targetWord = wordEntry[targetLang].trim();
      const englishWord = wordEntry.en.trim();
      const escapedWord = targetWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      
      // Strict word-boundary match
      const boundaryRegex = new RegExp(`\\b${escapedWord}\\b`, 'gi');
      if (boundaryRegex.test(processedText)) {
        processedText = processedText.replace(boundaryRegex, englishWord);
      } else {
        // Loose match as fallback
        const looseRegex = new RegExp(escapedWord, 'gi');
        processedText = processedText.replace(looseRegex, englishWord);
      }
    });
  } catch (error) {
    console.error('📚 Error in word replacement:', error);
  }
  
  return processedText;
}

// ================================
// LOGGING FUNCTIONS
// ================================

function logTranslation({ source, target, input, output, durationMs, accuracy, roomId }) {
  if (!roomId) return;

  // Get IST (Kolkata) time
  const istOffset = 5.5 * 60; // IST is UTC+5:30 in minutes
  const istDate = new Date(Date.now() + (istOffset - new Date().getTimezoneOffset()) * 60000);
  const logEntry = {
    timestamp: istDate.toISOString(),
    source,
    target,
    input,
    output,
    durationMs
  };

  // Create translation logs directory
  fs.mkdirSync(TRANSLATION_LOGS_DIR, { recursive: true });

  const dateStr = new Date().toISOString().slice(0,10).replace(/-/g, '');
  const filePath = path.join(TRANSLATION_LOGS_DIR, `${roomId}-${dateStr}.json`);

  // Write to per-room log file
  let logs = [];
  try {
    if (fs.existsSync(filePath)) {
      logs = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error('📝 Error reading translation log file:', e);
  }
  logs.push(logEntry);
  try {
    fs.writeFileSync(filePath, JSON.stringify(logs, null, 2), 'utf8');
    console.log(`📝 Translation log saved to: ${filePath}`);
  } catch (error) {
    console.error('📝 Error writing translation log:', error);
  }

  // Also append to main translation_logs.json
  let mainLogs = [];
  try {
    if (fs.existsSync(TRANSLATION_LOG_FILE)) {
      mainLogs = JSON.parse(fs.readFileSync(TRANSLATION_LOG_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('📝 Error reading main translation log file:', e);
  }
  mainLogs.push(logEntry);
  try {
    fs.writeFileSync(TRANSLATION_LOG_FILE, JSON.stringify(mainLogs, null, 2), 'utf8');
  } catch (error) {
    console.error('📝 Error writing main translation log:', error);
  }
}

async function saveTranscript(roomId) {
  const log = transcripts.get(roomId) || [];
  if (!log.length) return;

  // Create transcripts directory
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

  const filePath = path.join(TRANSCRIPTS_DIR, `${roomId}-${Date.now()}.txt`);
  const content = log.map(m =>
    `[${new Date(m.timestamp).toLocaleString()}] ${m.type === 'translation' ? '[TRANSLATED] ' : ''}${m.sender}: ${m.transcript}`
  ).join('\n');

  try {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`📄 Transcript saved to: ${filePath}`);
  } catch (error) {
    console.error(`📄 Error saving transcript for room ${roomId}:`, error);
  }
}

// ================================
// SOCKET UTILITY FUNCTIONS
// ================================

function emitAgentsOnline() {
  let availableCount = 0;
  for (const email in agentAvailability) {
    if (agentAvailability[email]) availableCount++;
  }
  io.emit('agents-online', availableCount);
}

function emitActiveMeetings() {
  const meetings = Array.from(rooms.entries())
    .filter(([_, room]) => room.isPublic && room.participants && room.participants.length > 0)
    .map(([roomId, room]) => ({ roomId, participants: room.participants.length }));
  io.emit('active-meetings', meetings);
}

function forwardToOther(roomId, senderId, event, payload) {
  const room = rooms.get(roomId);
  if (!room?.participants) return;
  
  const other = room.participants.find(id => id !== senderId);
  if (other) io.to(other).emit(event, payload);
}

function handleLeave(socket, roomId) {
  const room = rooms.get(roomId);
  if (!room?.participants) return;
  
  room.participants = room.participants.filter(id => id !== socket.id);
  rooms.set(roomId, room);
  socket.to(roomId).emit('user-disconnected');
  
  if (room.participants.length === 0) {
    saveTranscript(roomId).catch(console.error);
    rooms.delete(roomId);
    transcripts.delete(roomId);
  }
}

// ================================
// CLEANUP FUNCTIONS
// ================================

function performCleanup() {
  try {
    // Clean up disconnected agents
    const connectedEmails = new Set();
    for (const socket of io.sockets.sockets.values()) {
      const email = socket.handshake?.auth?.email || socket.data?.email;
      if (email) connectedEmails.add(email);
    }
    
    for (const email in agentAvailability) {
      if (!connectedEmails.has(email)) {
        delete agentAvailability[email];
      }
    }
    
    // Clean up old transcripts
    const cutoffTime = Date.now() - (config.transcriptRetentionHours * 60 * 60 * 1000);
    for (const [roomId, transcript] of transcripts.entries()) {
      if (transcript.length > 0 && transcript[0].timestamp < cutoffTime) {
        saveTranscript(roomId).catch(console.error);
        transcripts.delete(roomId);
      }
    }
    
    console.log(`🧹 Cleanup completed. Active rooms: ${rooms.size}, Active transcripts: ${transcripts.size}`);
  } catch (error) {
    console.error('🧹 Error during cleanup:', error);
  }
}

// ================================
// API ROUTES
// ================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    pythonServiceHealthy: pythonServiceHealthy,
    activeRooms: rooms.size,
    agentsOnline: Object.values(agentAvailability).filter(Boolean).length
  };
  res.json(health);
});

// Live stats API
app.get('/api/live-stats', (req, res) => {
  let liveCalls = 0;
  let agentSet = new Set();
  
  for (const [roomId, room] of rooms.entries()) {
    if (room.participants && room.participants.length > 0) {
      liveCalls++;
    }
    
    if (room.participants) {
      for (const socketId of room.participants) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          const email = socket.handshake?.auth?.email || socket.data?.email;
          if (email && !/@employee\.com$/i.test(email)) {
            agentSet.add(email);
          }
        }
      }
    }
  }
  
  res.json({ liveCalls, agentsOnline: agentSet.size });
});

// Translation API - Updated to use Python microservice
app.post('/api/translate', async (req, res) => {
  try {
    const { text, source = 'auto', target = 'en', reference, roomId } = req.body;
    
    // Validate input
    const validation = validateInput(text);
    if (!validation.isValid) {
      return res.status(400).json({ error: validation.error });
    }

    // Check if Python service is available
    if (!pythonServiceHealthy) {
      const healthCheck = await checkPythonServiceHealth();
      if (!healthCheck) {
        return res.status(503).json({ 
          error: 'Translation service unavailable - Python microservice is not responding' 
        });
      }
    }

    const startTime = Date.now();
    const sl = source.split('-')[0];
    const tl = target.split('-')[0];
    
    console.log(`🔄 Translating with Python service: ${sl} -> ${tl}`);
    
    // Call Python microservice for translation
    const translationResult = await translateWithPythonService(validation.text, sl, tl);
    let translatedText = translationResult.translatedText;

    // Apply enterprise dictionary replacements
    translatedText = applyWordReplacements(translatedText, tl);

    const durationMs = Date.now() - startTime;

    // Calculate accuracy if reference provided
    let accuracy = null;
    if (reference) {
      // Simple word overlap accuracy - you can implement BLEU score here
      const refWords = reference.toLowerCase().split(/\s+/);
      const outWords = translatedText.toLowerCase().split(/\s+/);
      const intersection = refWords.filter(word => outWords.includes(word));
      accuracy = intersection.length / Math.max(refWords.length, outWords.length);
    }

    // Log translation (always log, even if no roomId)
    let logRoomId = roomId;
    if (!logRoomId) {
      // Use a default or random roomId for logging if not provided
      logRoomId = 'general-' + new Date().toISOString().slice(0,10).replace(/-/g, '');
    }
    
    logTranslation({ 
      source, 
      target, 
      input: text, 
      output: translatedText, 
      durationMs, 
      accuracy, 
      roomId: logRoomId 
    });
    
    console.log(`✅ Translation completed: ${sl} -> ${tl}, duration: ${durationMs}ms`);
    res.json({ translated: translatedText });
    
  } catch (err) {
    console.error('❌ Translation error:', err);
    
    // Provide more specific error messages
    if (err.message.includes('timeout')) {
      res.status(504).json({ error: 'Translation timeout - request took too long' });
    } else if (err.message.includes('Translation failed')) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: 'Translation service temporarily unavailable' });
    }
  }
});

// Python service status endpoint
app.get('/api/python-service-status', async (req, res) => {
  try {
    const isHealthy = await checkPythonServiceHealth();
    res.json({
      url: config.pythonServiceUrl,
      healthy: isHealthy,
      lastChecked: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      url: config.pythonServiceUrl,
      healthy: false,
      error: error.message,
      lastChecked: new Date().toISOString()
    });
  }
});

// Translation logs API
app.get('/api/translation-logs', (req, res) => {
  try {
    const logs = fs.existsSync(TRANSLATION_LOG_FILE)
      ? JSON.parse(fs.readFileSync(TRANSLATION_LOG_FILE, 'utf8'))
      : [];
    res.json(logs);
  } catch (err) {
    console.error('📝 Error reading translation logs:', err);
    res.status(500).json({ error: 'Failed to read translation logs' });
  }
});

// Dictionary management routes
app.get('/api/dictionary', (req, res) => {
  res.json(excludedWords);
});

app.post('/api/dictionary', (req, res) => {
  try {
    const wordEntry = req.body;
    if (!wordEntry.en) {
      return res.status(400).json({ error: 'English word is required' });
    }
    
    const existingIndex = excludedWords.findIndex(word =>
      word.en?.toLowerCase() === wordEntry.en.toLowerCase()
    );
    
    if (existingIndex !== -1) {
      excludedWords[existingIndex] = { ...excludedWords[existingIndex], ...wordEntry };
    } else {
      excludedWords.push(wordEntry);
    }
    
    saveExcludedWords();
    res.json({ message: 'Word added successfully', wordCount: excludedWords.length });
  } catch (error) {
    console.error('📚 Error adding word:', error);
    res.status(500).json({ error: 'Failed to add word' });
  }
});

app.delete('/api/dictionary/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);
    if (index < 0 || index >= excludedWords.length) {
      return res.status(404).json({ error: 'Word not found' });
    }
    
    excludedWords.splice(index, 1);
    saveExcludedWords();
    res.json({ message: 'Word deleted successfully', wordCount: excludedWords.length });
  } catch (error) {
    console.error('📚 Error deleting word:', error);
    res.status(500).json({ error: 'Failed to delete word' });
  }
});

app.delete('/api/dictionary', (req, res) => {
  try {
    excludedWords = [];
    saveExcludedWords();
    res.json({ message: 'Dictionary cleared successfully' });
  } catch (error) {
    console.error('📚 Error clearing dictionary:', error);
    res.status(500).json({ error: 'Failed to clear dictionary' });
  }
});

// Feedback API
app.post('/api/feedback', async (req, res) => {
  try {
    const feedback = req.body;
    const dirPath = path.join(__dirname, 'feedback_response');
    fs.mkdirSync(dirPath, { recursive: true });
    
    const timestamp = Date.now();
    fs.writeFileSync(
      path.join(dirPath, `feedback-${timestamp}.json`), 
      JSON.stringify(feedback, null, 2), 
      'utf8'
    );

    // Save to Excel
    const excelPath = path.join(dirPath, 'employee_feedback.xlsx');
    const workbook = new ExcelJS.Workbook();
    let worksheet;
    
    if (fs.existsSync(excelPath)) {
      await workbook.xlsx.readFile(excelPath);
      worksheet = workbook.getWorksheet('Feedback') || workbook.worksheets[0];
    } else {
      worksheet = workbook.addWorksheet('Feedback');
      worksheet.columns = [
        { header: 'Timestamp', key: 'timestamp', width: 24 },
        { header: 'Employee', key: 'employee', width: 24 },
        { header: 'Type', key: 'type', width: 20 },
        { header: 'Rating', key: 'rating', width: 10 },
        { header: 'Comments', key: 'comments', width: 40 }
      ];
    }
    
    worksheet.addRow({
      timestamp: new Date(timestamp).toLocaleString(),
      employee: feedback.employee || feedback.email || feedback.userEmail || '',
      type: feedback.type || '',
      rating: feedback.rating || '',
      comments: feedback.comments || feedback.feedback || ''
    });
    
    await workbook.xlsx.writeFile(excelPath);
    res.status(200).json({ message: 'Feedback saved successfully' });
  } catch (err) {
    console.error('📝 Error saving feedback:', err);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

// ================================
// SOCKET.IO HANDLERS
// ================================

io.on('connection', (socket) => {
  console.log('👤 User connected:', socket.id);
  
  // Send current agent count to new connections
  setTimeout(() => {
    let availableCount = 0;
    for (const email in agentAvailability) {
      if (agentAvailability[email]) availableCount++;
    }
    socket.emit('agents-online', availableCount);
  }, 500);

  // Handle agent availability changes
  socket.on('agent-availability-changed', (data) => {
    if (data && data.email) {
      agentAvailability[data.email] = !!data.available;
      emitAgentsOnline();
    }
  });

  // Handle explicit agent count requests
  socket.on('get-agents-online', () => {
    let availableCount = 0;
    for (const email in agentAvailability) {
      if (agentAvailability[email]) availableCount++;
    }
    console.log(`[get-agents-online] Emitting agents-online:`, availableCount);
    socket.emit('agents-online', availableCount);
  });

  // Handle room creation
  socket.on('createRoom', (roomId, lang) => {
    if (!roomId || typeof roomId !== 'string') {
      socket.emit('createRoomResult', { success: false, error: 'Invalid roomId' });
      return;
    }
    if (rooms.has(roomId)) {
      socket.emit('createRoomResult', { success: false, error: 'Room already exists' });
      return;
    }
    
    rooms.set(roomId, { participants: [], isPublic: true, lang });
    socket.emit('createRoomResult', { success: true, roomId });
  });

  // Handle room joining
  socket.on('join', (roomId, opts = {}) => {
    if (!roomId || typeof roomId !== 'string') {
      socket.emit('error', 'Invalid roomId');
      return;
    }
    
    if (!rooms.has(roomId)) {
      if (opts.isCreator) {
        rooms.set(roomId, { 
          participants: [socket.id], 
          isPublic: opts.isPublic !== false 
        });
        socket.join(roomId);
        socket.emit('created', roomId);
      } else {
        socket.emit('no-room', roomId);
      }
      return;
    }
    
    const room = rooms.get(roomId);
    if ((room.participants || []).length >= config.maxRoomParticipants) {
      socket.emit('full', roomId);
      return;
    }
    
    socket.join(roomId);
    room.participants.push(socket.id);
    rooms.set(roomId, room);
    
    if (room.participants.length === 1) {
      socket.emit('created', roomId);
    } else if (room.participants.length === 2) {
      socket.emit('joined', roomId);
      io.to(room.participants[0]).emit('user-joined');
    }
    
    emitActiveMeetings();
  });

  // WebRTC signaling
  socket.on('offer', (offer, roomId) => forwardToOther(roomId, socket.id, 'offer', offer));
  socket.on('answer', (answer, roomId) => forwardToOther(roomId, socket.id, 'answer', answer));
  socket.on('ice-candidate', (candidate, roomId) => forwardToOther(roomId, socket.id, 'ice-candidate', candidate));

  // Handle transcripts
  socket.on('transcript', (msg) => {
    if (!msg?.roomId) return;
    
    if (!transcripts.has(msg.roomId)) {
      transcripts.set(msg.roomId, []);
    }
    
    transcripts.get(msg.roomId).push({ 
      ...msg, 
      timestamp: msg.timestamp || Date.now() 
    });
    
    if (!msg.type || msg.type !== 'translation') {
      const room = rooms.get(msg.roomId);
      const other = room?.participants?.find(id => id !== socket.id);
      if (other) io.to(other).emit('transcript', msg);
    }
  });

  // Handle local translations
  socket.on('local-translation', (data) => {
    if (data.to) {
      io.to(data.to).emit('local-translation', { 
        ...data, 
        timestamp: data.timestamp || Date.now() 
      });
    }
  });

  // Handle leaving rooms
  socket.on('leave', (roomId) => {
    handleLeave(socket, roomId);
    const room = rooms.get(roomId);
    if (!room?.participants?.length) {
      rooms.delete(roomId);
      transcripts.delete(roomId);
    }
    emitActiveMeetings();
  });

  // Handle active meetings requests
  socket.on('get-active-meetings', () => {
    const meetings = Array.from(rooms.entries())
      .filter(([_, room]) => room.isPublic && room.participants && room.participants.length > 0)
      .map(([roomId, room]) => ({ roomId, participants: room.participants.length }));
    socket.emit('active-meetings', meetings);
  });

  // Handle disconnection
  socket.on('disconnecting', () => {
    socket.rooms.forEach((roomId) => {
      if (roomId !== socket.id) {
        handleLeave(socket, roomId);
      }
    });
  });

  socket.on('disconnect', () => {
    emitActiveMeetings();
    emitAgentsOnline();
    console.log('👤 User disconnected:', socket.id);
  });
});

// ================================
// GRACEFUL SHUTDOWN
// ================================

async function gracefulShutdown(signal) {
  console.log(`🔄 Received ${signal}, shutting down gracefully...`);
  
  // Save all pending transcripts
  const savePromises = Array.from(rooms.keys()).map(roomId => 
    saveTranscript(roomId).catch(error => 
      console.error(`📄 Error saving transcript for room ${roomId}:`, error)
    )
  );
  
  await Promise.allSettled(savePromises);
  
  // Close server
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
  
  // Force close after 10 seconds
  setTimeout(() => {
    console.log('❌ Force closing server');
    process.exit(1);
  }, 10000);
}

// ================================
// INITIALIZATION
// ================================

async function initialize() {
  try {
    // Load dictionary
    loadExcludedWords();
    
    // Create directories for organized storage
    fs.mkdirSync(TRANSLATION_LOGS_DIR, { recursive: true });
    fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
    console.log(`📁 Created directories:`);
    console.log(`   - Translation logs: ${TRANSLATION_LOGS_DIR}`);
    console.log(`   - Transcripts: ${TRANSCRIPTS_DIR}`);
    
    // Check Python service health
    console.log(`🐍 Checking Python translation service at ${config.pythonServiceUrl}...`);
    const pythonHealthy = await checkPythonServiceHealth();
    
    if (pythonHealthy) {
      console.log('✅ Python translation service is healthy');
    } else {
      console.log('⚠️  Python translation service is not available. Translation will not work until the service is started.');
      console.log('   Start the Python service with: cd nllb_translation_service && python main.py');
    }
    
    // Start cleanup interval
    setInterval(performCleanup, config.cleanupInterval);
    
    // Periodic health checks for Python service
    setInterval(async () => {
      await checkPythonServiceHealth();
    }, 30000); // Check every 30 seconds
    
    // Setup graceful shutdown
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
    
    // Start server
    server.listen(config.port, () => {
      console.log('Listening on port:', config.port);
      console.log(`🚀 Node.js server running at http://localhost:${config.port}`);
      console.log(`📊 Health check available at http://localhost:${config.port}/health`);
      console.log(`🐍 Python service expected at ${config.pythonServiceUrl}`);
    });
    
  } catch (error) {
    console.error('❌ Failed to initialize server:', error);
    process.exit(1);
  }
}

// Start the server
initialize();
