// src/routes/mail.route.js
import express from "express";
import { getAllMails, getSingleEmail, receivedEmail, sendEmail } from "../controllers/mail.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { verifySubscription } from "../middlewares/subscription.middleware.js";

const router = express.Router();
router.use(requireAuth)

router.post('sent-email',verifySubscription("sendMail"), sendEmail)
router.get('recived-email', receivedEmail)
router.get('get-single-email', getSingleEmail)
router.get('get-all-mails', getAllMails)

export default router;
