import express from "express";
import {
  signup,
  login,
  refreshAccessToken,
  logout,
  getCurrentUser,
  changePassword,
  forgotPassword,
  resetPassword,
  updateProfile,
  allAdmins,
  toggleAdminStatus,
} from "../controllers/auth.controller.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";

const router = express.Router();

// Public
router.post("/signup", signup);
router.post("/login", login);
router.put("/profile-update", requireAuth, updateProfile);
router.post("/refresh", refreshAccessToken);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", requireAuth, resetPassword);

router.post("/logout", requireAuth, logout);
router.get("/get-current-user", requireAuth, getCurrentUser);
router.post("/change-password", requireAuth, changePassword);

// ================= super admin ========================

router.get("/all-admins", requireAuth, requireRole(["SUPER_ADMIN"]), allAdmins);
router.patch(
  "admin-toggle/:userId",
  requireAuth,
  requireRole(["SUPER_ADMIN"]),
  toggleAdminStatus
);
export default router;
