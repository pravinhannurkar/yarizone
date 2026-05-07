# Yarizone Backend

Node.js + Express + Socket.io server for random video calling

## Features

- Real-time user matching
- WebRTC signaling (offer, answer, ICE candidates)
- Text chat during calls
- User queue management
- Connection handling and cleanup

## Installation

```bash
npm install
```

## Environment Variables

Create a `.env` file:

```env
PORT=3000
CLIENT_URL=http://localhost:5173
NODE_ENV=development
```

## Running

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

## API Endpoints

- `GET /health` - Health check with server stats
- `GET /stats` - Current server statistics

## Socket.io Events

### Client -> Server

- `join` - Join the waiting queue
- `offer` - Send WebRTC offer
- `answer` - Send WebRTC answer
- `ice-candidate` - Send ICE candidate
- `chat-message` - Send chat message
- `skip` - Skip current user
- `end-call` - End current call
- `disconnect` - Handle disconnection

### Server -> Client

- `waiting` - Waiting for match
- `match-found` - Match found with peer info
- `offer` - Receive WebRTC offer
- `answer` - Receive WebRTC answer
- `ice-candidate` - Receive ICE candidate
- `chat-message` - Receive chat message
- `user-skipped` - Peer user skipped
- `user-disconnected` - Peer user disconnected
- `error` - Error message

## Architecture

```
server/
├── src/
│   └── server.js       # Main server file
├── .env                # Environment variables
└── package.json        # Dependencies
```

## How It Works

1. Users connect and emit `join` event
2. Server adds them to waiting queue
3. When 2+ users are waiting, server matches them
4. Both users receive `match-found` with peer info
5. Users exchange WebRTC signaling through server
6. P2P video/audio connection established
7. Users can chat or skip to next user
8. On disconnect, clean up and re-queue remaining users
