import mongoose from "mongoose";
import logToFile from "../logger.js"; // Assuming your logger is here

const connectDB = async () => {
  const uri = process.env.MONGODB_URI;

  // 1. Fail-Fast Validation
  if (!uri) {
    logToFile("❌ MONGODB_URI is not set. Check environment variables.");
    process.exit(1); // Stop the server immediately
  }

  // 2. Set strict options (standard in Mongoose 8+)
  mongoose.set("strictQuery", true);

  // 3. Post-Connection Event Listeners
  // Mongoose handles reconnections automatically, but you must listen 
  // to these events to log when your database drops or reconnects.
  mongoose.connection.on("connected", () => logToFile(`[DB] ✅ Connected -> ${mongoose.connection.name}`));
  mongoose.connection.on("error", (err) => logToFile(`[DB] ⚠️ Connection error: ${err.message}`));
  mongoose.connection.on("disconnected", () => logToFile(`[DB] ⚠️ Disconnected from MongoDB.`));

  // 4. Initial Connection with Production Options
  try {
    const options = {
      maxPoolSize: 50, // Adjust based on your traffic (default is 100)
      serverSelectionTimeoutMS: 5000, // Fail after 5 seconds instead of hanging indefinitely
      autoIndex: false, // MUST be false in large production DBs to prevent performance degradation
    };

    await mongoose.connect(uri, options);

  } catch (error) {
    logToFile(`[DB] ❌ Initial connection failed: ${error.message}`);
    process.exit(1);
  }
};

export default connectDB;