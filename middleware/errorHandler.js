import logToFile from "../logger.js"

// Centralized error handler: keeps stack traces out of API responses and
// gives Mongoose validation/cast errors a consistent, friendly shape.
const errorHandler = (err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  logToFile(`[Centralized Error] ${err}`);

  if (err.name === "ValidationError") {
    return res.status(400).json({
      message: Object.values(err.errors)[0]?.message || "Invalid data.",
    });
  }

  if (err.code === 11000) {
    return res.status(409).json({
      message: "That value is already in use.",
    });
  }

  if (err.name === "CastError") {
    return res.status(400).json({
      message: "Invalid identifier.",
    });
  }

  return res.status(err.status || 500).json({
    message: err.expose
      ? err.message
      : "Something went wrong on our end.",
  });
};

export default errorHandler;