// src/routes/mail.route.js
import express from "express";
import {
  deleteMail,
  getAllMails,
  getBySingleMail,
  getSentMails,
  getSingleEmail,
  receivedEmail,
  sendEmail,
} from "../controllers/mail.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { verifySubscription } from "../middlewares/subscription.middleware.js";

const router = express.Router();
router.use(requireAuth);

router.post("/sent-email", verifySubscription("sendMail"), sendEmail);
router.get("/recived-email", receivedEmail);
router.get("/get-single-email", getSingleEmail);
router.get("/get-all-mails", getAllMails);
router.get("/get-all-sent-mails", getSentMails);
router.get("/get-by-single-mail/:id", getBySingleMail);
router.get("/delete-mail/:id", deleteMail);

export default router;
