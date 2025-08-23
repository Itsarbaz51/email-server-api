import jwt from "jsonwebtoken";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import Prisma from "../db/db.js";

const requireAuth = asyncHandler(async (req, res, next) => {
  const token =
    req.cookies?.accessToken ||
    (req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer ") &&
      req.headers.authorization.split(" ")[1]) ||
    req.body?.accessToken;

  if (!token) return ApiError.send(res, 401, "Access token missing");

  try {
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

    if (!decoded?.id || !decoded?.role) {
      return ApiError.send(res, 401, "Invalid token payload");
    }

    const user = await Prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, role: true },
    });

    if (user) {
      req.user = {
        id: user.id,
        email: user.email,
        role: user.role, // "ADMIN" | "SUPER_ADMIN"
        model: "ADMIN",
      };
      return next();
    }

    const mailbox = await Prisma.mailbox.findUnique({
      where: { id: decoded.id },
      select: { id: true, emailAddress: true },
    });

    if (mailbox) {
      req.mailbox = {
        id: mailbox.id,
        email: mailbox.emailAddress,
        role: "USER", 
        model: "MAILBOX",
      };
      return next();
    }

    return ApiError.send(res, 401, "You are not authorized. Please login.");
  } catch (error) {
    return ApiError.send(res, 401, "Invalid or expired access token");
  }
});

const requireRole = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user) {
      return ApiError.send(res, 401, "Not authenticated");
    }

    if (req.user.model !== "USER") {
      return ApiError.send(res, 403, "Mailbox users not allowed");
    }

    if (!allowedRoles.includes(req.user.role)) {
      return ApiError.send(res, 403, "Forbidden: Insufficient privileges");
    }

    return next();
  };
};

export { requireAuth, requireRole };
