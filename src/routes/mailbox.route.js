import express from "express";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { createMailbox, deleteMailbox, getMailboxes, updateMailbox } from "../controllers/mailbox.controller.js";

const router = express.Router();
router.use(requireAuth)

router.post("/create-mailbox", createMailbox)
router.put("update-mailbox", updateMailbox)
router.get("/get-mailbox", getMailboxes);
router.delete("delete-mailbox", deleteMailbox)

export default router;
