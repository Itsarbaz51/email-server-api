// src/routes/mail.route.js
import express from "express";
import {
  addStarred,
  bulkMailDelete,
  deleteMail,
  getAllMails,
  getAllStarred,
  getArchiveMails,
  getBySingleMail,
  getEmailBody,
  getSentMails,
  getSingleEmail,
  getTrashMails,
  moveToArchive,
  moveToTrash,
  receivedEmail,
  removeStarred,
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

router.delete("/delete-mail/:id", deleteMail);
router.delete("/bulk-delete-mail", bulkMailDelete);

router.post("/move-to-trash", moveToTrash);
router.post("/move-to-archive", moveToArchive);
router.get("/get-archive", getArchiveMails);

router.get("/get-trash", getTrashMails);

router.post("/add-starred/:mailId", addStarred);
router.delete("/remove-starred/:mailId", removeStarred);
router.get("/get-all-starred", getAllStarred);



router.get("/body/:type/:emailId", getEmailBody);

export default router;
