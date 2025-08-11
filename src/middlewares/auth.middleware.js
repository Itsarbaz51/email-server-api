import jwt from "jsonwebtoken";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import Prisma from "../db/db.js";

/**
 * requireAuth middleware reads accessToken from cookie or Authorization header
 * and populates req.user = { id, email, role, model: "USER" | "MAILBOX" }
 */
const requireAuth = asyncHandler(async (req, res, next) => {
  const token =
    req.cookies?.accessToken ||
    (req.headers.authorization && req.headers.authorization.split(" ")[1]) ||
    req.body?.accessToken;

  if (!token) return ApiError.send(res, 401, "Access token missing");

  try {
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

    // Try to find in users table
    const user = await Prisma.user.findUnique({ where: { id: decoded.id }, select: { id: true, email: true, role: true } });
    if (user) {
      req.user = { id: user.id, email: user.email, role: user.role, model: "USER" };
      return next();
    }

    // Otherwise try mailbox
    const mailbox = await Prisma.mailbox.findUnique({ where: { id: decoded.id }, select: { id: true, emailAddress: true } });
    if (mailbox) {
      req.user = { id: mailbox.id, email: mailbox.emailAddress, role: "USER", model: "MAILBOX" };
      return next();
    }

    return ApiError.send(res, 401, "User not found");
  } catch (err) {
    return ApiError.send(res, 401, "Invalid or expired access token");
  }
});

/**
 * requireRole - ensure user has one of allowed roles (for User model only)
 * allowedRoles: array like ['ADMIN','SUPER_ADMIN']
 */
const requireRole = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user) return ApiError.send(res, 401, "Not authenticated");
    if (req.user.model !== "USER") return ApiError.send(res, 403, "Insufficient privileges");

    if (!allowedRoles.includes(req.user.role)) return ApiError.send(res, 403, "Forbidden");
    return next();
  };
};

export { requireAuth, requireRole };
