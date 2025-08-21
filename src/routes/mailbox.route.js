import express from "express";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";
import {
  allMailbox,
  createMailbox,
  deleteMailbox,
  getMailboxes,
  updateMailbox,
} from "../controllers/mailbox.controller.js";
import { verifySubscription } from "../middlewares/subscription.middleware.js";

const router = express.Router();
router.use(requireAuth);

router.post(
  "/create-mailbox",
  verifySubscription("createMailbox"),
  createMailbox
);
router.put(
  "/update-mailbox/:id",
  verifySubscription("createMailbox"),
  updateMailbox
);
router.get("/get-mailbox", getMailboxes);
router.delete("/delete-mailbox/:id", deleteMailbox);

// ================= super admin ========================

router.post(
  "/all-mailboxs",
  requireAuth,
  requireRole(["SUPER_ADMIN"]),
  allMailbox
);

export default router;
