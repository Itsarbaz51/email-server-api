class ApiError extends Error {
    static send(res, statusCode, message = "Something went wrong!", errors = []) {
      return res.status(statusCode).json({
        success: false,
        message,
        errors,
        stack:
          process.env.NODE_ENV === "development" ? new Error().stack : undefined,
      });
    }
  }
  
  export { ApiError };