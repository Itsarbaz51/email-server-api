import express from "express";
import {
  signupAdmin,
  signup,
  login,
  refreshAccessToken,
  logout,
  me,
  changePassword,
  forgotPassword,
  resetPassword,
} from "../controllers/auth.controller.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";

const router = express.Router();

// Public
router.post("/signup", signup); // public user signup
router.post("/login", login);
router.post("/refresh", refreshAccessToken);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

// Protected
router.post("/signup-admin", requireAuth, requireRole(["SUPER_ADMIN"]), signupAdmin); // only SUPER_ADMIN can create admins
router.post("/logout", requireAuth, logout);
router.get("/me", requireAuth, me);
router.post("/change-password", requireAuth, changePassword);

export default router;
