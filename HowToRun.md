# 🚀 Leap360: Full Setup Guide (No Docker)

Welcome! This document explains how to run the Leap360 Agent Control Plane fully on your local machine without needing Docker, PostgreSQL, or Redis.

## 🛠 Prerequisites
- **Node.js** (v18 or higher)
- **pnpm** (If you have it installed but see "script execution disabled" errors, follow the commands below carefully).

---

## 🏃‍♂️ Step-by-Step Execution

### 1. Install Dependencies
Run this in the root folder of the project to ensure everything is installed:
```powershell
cmd /c pnpm install
```

### 2. Setup the Database (SQLite)
Traditional setup uses PostgreSQL, but we've switched this version to use a local **SQLite** file for simplicity.
Run the following to initialize the database:
```powershell
# Create the database schema
cmd /c pnpm migrate

# Seed initial data (API keys and a sample project)
cmd /c pnpm seed
```

### 3. Start the Server & Dashboard
Now, start the API and the Web Dashboard at the same time:
```powershell
cmd /c pnpm dev
```
- **API Server:** http://localhost:4000
- **Web Dashboard:** http://localhost:5173

---

## 🧪 Testing with the SDK
We have included a demo script that mocks a real AI trace using the `@leap360/sdk`.

### 1. Navigate to the example folder
```powershell
cd example
```

### 2. Install example dependencies
```powershell
cmd /c pnpm install
```

### 3. Run the demo
```powershell
cmd /c pnpm start
```

### 4. Check the Dashboard
Go to [http://localhost:5173](http://localhost:5173). You should see:
1. Traces arriving in real-time.
2. The "example-backend-service" appearing in the services list.

---

## 🔝 Advanced Demo: Live Agent Simulation
For a more impressive demo with multiple agents (Customer Support, Code Review Bot, Analysts), use the `demo-agent`:

1. **Navigate to the demo-agent folder:**
   ```powershell
   cd c:\Users\amir\Desktop\Leap360-AI-main\demo-agent
   ```
2. **Install and Run:**
   ```powershell
   cmd /c pnpm install
   cmd /c npx tsx agent.ts
   ```
3. **Watch the Dashboard:** 
   This agent will simulate real AI conversations across 5 different departments every 8 seconds. Watch your dashboard fill up with live traces!

---

## 🔑 Default Credentials
- **Admin Email:** `admin@leap360.ai`
- **Admin Password:** `admin123`
- **Default API Key:** `leap360-dev-secret-key-change-me`
