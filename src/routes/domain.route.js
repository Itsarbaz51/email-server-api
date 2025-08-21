import { Router } from "express";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";
import {
  addDomain,
  verifyDomain,
  getDomains,
  deleteDomain,
  allDomains,
} from "../controllers/domain.controller.js";
import { verifySubscription } from "../middlewares/subscription.middleware.js";

const router = Router();

router.post(
  "/add-domain",
  requireAuth,
  verifySubscription("createDomain"),
  addDomain
);
router.get("/get-domains", requireAuth, getDomains);

router.get(
  "/verify-domain/:domainName",
  requireAuth,
  verifySubscription("verifyDomain"),
  verifyDomain
);
router.delete("/delete-domain/:domainName", requireAuth, deleteDomain);

// ================= super admin ========================

router.get(
  "/all-admins",
  requireAuth,
  requireRole(["SUPER_ADMIN"]),
  allDomains
);

export default router;
