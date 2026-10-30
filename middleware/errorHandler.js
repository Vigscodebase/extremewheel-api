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

  // Body bigger than express.json's limit, or a document over MongoDB's 16 MB cap
  // (usually too many / too large photos on one vehicle).
  if (err.type === "entity.too.large" || err.name === "BSONObjectTooLargeError" || err.code === 10334 || /exceeds maximum|BSONObj size/i.test(err.message || "")) {
    return res.status(413).json({
      message: "The photos on this vehicle are too large to save. Remove a photo or use smaller images and try again.",
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