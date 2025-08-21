import Prisma from "../db/db.js";
import jwt from "jsonwebtoken";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  comparePassword,
  generateAccessToken,
  generateRefreshToken,
  hashPassword,
} from "../utils/lib.js";

const cookieOptions = {
  httpOnly: true,
  sameSite: "none",
  domain: ".primewebdev.in",
  secure: true,
};

// sigup public route admin
const signup = asyncHandler(async (req, res) => {
  const { name, email, phone, password, termsAndConditions } = req.body;
  if (
    ![name, email, phone, password, termsAndConditions].every(
      (v) => v && String(v).trim().length > 0
    )
  ) {
    return ApiError.send(res, 400, "All fields are required");
  }

  const exists = await Prisma.user.findFirst({
    where: { OR: [{ email }, { phone }] },
  });

  if (exists) return ApiError.send(res, 409, "Email already registered");

  const hashed = await hashPassword(password);
  if (!hashed) return ApiError.send(res, 500, "Password hashing failed");

  const user = await Prisma.user.create({
    data: {
      name,
      email,
      phone,
      password: hashed,
      role: "ADMIN",
      termsAndConditions,
      isActive: true,
    },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });

  return res
    .status(201)
    .json(new ApiResponse(201, "Registered successfully", { user }));
});

// login
const login = asyncHandler(async (req, res) => {
  const { emailOrPhone, password } = req.body;
  console.log("LOGIN BODY:", req.body);

  if (!emailOrPhone || !password) {
    return ApiError.send(res, 400, "Email/Phone and password are required");
  }

  // 1. Try finding in User table (Admin / Super Admin)
  const user = await Prisma.user.findFirst({
    where: {
      OR: [{ email: emailOrPhone.toLowerCase() }, { phone: emailOrPhone }],
    },
    select: {
      id: true,
      email: true,
      password: true,
      role: true,
      name: true,
    },
  });

  // ✅ If user not found in User table → check Mailbox (USER role)
  if (!user) {
    const mailbox = await Prisma.mailbox.findFirst({
      where: { emailAddress: emailOrPhone },
    });

    if (!mailbox) return ApiError.send(res, 404, "Mailbox user not found");

    const isPasswordValid = await comparePassword(password, mailbox.password);
    if (!isPasswordValid) return ApiError.send(res, 403, "Password Invalid");

    const updatedMailbox = await Prisma.mailbox.update({
      where: { id: mailbox.id },
      data: { lastLoginAt: new Date() },
    });

    const accessToken = generateAccessToken(
      updatedMailbox.id,
      updatedMailbox.emailAddress,
      "USER"
    );
    const refreshToken = generateRefreshToken(
      updatedMailbox.id,
      updatedMailbox.emailAddress,
      "USER"
    );

    const { password: _, lastLoginAt, ...mailboxSafe } = updatedMailbox;

    return res
      .status(200)
      .cookie("accessToken", accessToken, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        domain: ".primewebdev.in",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      })
      .cookie("refreshToken", refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        domain: ".primewebdev.in",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      })
      .json(
        new ApiResponse(200, "Login successful", {
          ...mailboxSafe,
          role: "USER",
        })
      );
  }

  // ✅ If User exists (Admin / Super Admin)
  const isPasswordValid = await comparePassword(password, user.password);
  if (!isPasswordValid) {
    return ApiError.send(res, 401, "Invalid credentials");
  }

  // Ensure role is either ADMIN or SUPER_ADMIN
  let userRole = "ADMIN";
  if (user.role === "SUPER_ADMIN") {
    userRole = "SUPER_ADMIN";
  }

  const accessToken = generateAccessToken(user.id, user.email, userRole);
  const refreshToken = generateRefreshToken(user.id, user.email, userRole);

  const { password: _, ...userSafe } = user;

  return res
    .status(200)
    .cookie("accessToken", accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      domain: ".primewebdev.in",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })
    .cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      domain: ".primewebdev.in",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })
    .json(
      new ApiResponse(200, "Login successful", {
        ...userSafe,
        role: userRole,
      })
    );
});

// refreshAccessToken
const refreshAccessToken = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!token) return ApiError.send(res, 401, "Refresh token missing");

  try {
    const decoded = jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);

    let newAccessToken;

    if (
      decoded.role === "ADMIN" ||
      decoded.role === "SUPER_ADMIN" ||
      decoded.role === "USER"
    ) {
      const user = await Prisma.user.findUnique({
        where: { id: decoded.id },
        select: { id: true, email: true, role: true },
      });

      if (!user) return ApiError.send(res, 401, "User not found");

      newAccessToken = generateAccessToken(user.id, user.email, user.role);
    } else {
      const mailbox = await Prisma.mailbox.findUnique({
        where: { id: decoded.id },
        select: { id: true, emailAddress: true },
      });

      if (!mailbox) return ApiError.send(res, 401, "Mailbox not found");

      newAccessToken = generateAccessToken(
        mailbox.id,
        mailbox.emailAddress,
        "USER"
      );
    }

    res.cookie("accessToken", newAccessToken, {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(200).json(
      new ApiResponse(200, "Access token refreshed", {
        accessToken: newAccessToken,
        expiresIn: process.env.ACCESS_TOKEN_EXPIRY || "7d",
      })
    );
  } catch (err) {
    return ApiError.send(res, 401, "Invalid or expired refresh token");
  }
});

// logout
const logout = asyncHandler(async (req, res) => {
  res
    .clearCookie("accessToken", cookieOptions)
    .clearCookie("refreshToken", cookieOptions);

  return res.status(200).json(new ApiResponse(200, "Logged out successfully"));
});

// update profile or mailbox
const updateProfile = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  const mailboxId = req.mailbox?.id;

  if (!userId && !mailboxId) {
    return ApiError.send(res, 401, "Not authenticated");
  }

  const { name, email, phone, password } = req.body;

  // At least one field required
  if (
    ![name, email, phone, password].some((f) => f && f.trim && f.trim() !== "")
  ) {
    return ApiError.send(
      res,
      400,
      "At least one field is required to update profile"
    );
  }

  let updatedResult;

  if (userId) {
    // User/Admin update
    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (phone) updateData.phone = phone;
    if (password) {
      const hashedPassword = await hashPassword(password);
      updateData.password = hashedPassword;
    }

    updatedResult = await Prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.status(200).json(
      new ApiResponse(200, "User profile updated successfully", {
        user: updatedResult,
      })
    );
  }

  if (mailboxId) {
    // Mailbox update: only name & emailAddress
    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.emailAddress = email;

    updatedResult = await Prisma.mailbox.update({
      where: { id: mailboxId },
      data: updateData,
      select: {
        id: true,
        name: true,
        emailAddress: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.status(200).json(
      new ApiResponse(200, "Mailbox updated successfully", {
        mailbox: updatedResult,
      })
    );
  }
});

// get current user
const getCurrentUser = asyncHandler(async (req, res) => {
  const userId = req?.user?.id;
  console.log(userId);
  const mailboxId = req?.mailbox?.id;
  console.log("mailboxId", mailboxId);

  if (!userId && !mailboxId)
    return ApiError.send(res, 401, "Not authenticated");

  if (userId) {
    const user = await Prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        phone: true,
        createdAt: true,
      },
    });

    if (!user) return ApiError.send(res, 404, "User not found");

    return res.status(200).json(new ApiResponse(200, "OK", { user: user }));
  }

  if (mailboxId) {
    const mailboxExits = await Prisma.mailbox.findUnique({
      where: { id: mailboxId },
    });

    console.log("mailboxExits", mailboxExits);

    if (!mailboxExits) return ApiError.send(res, 404, "mailbox user not found");
    const { password: _, ...mailboxSafe } = mailboxExits;

    const mailboxResponse = {
      ...mailboxSafe,
      role: "USER",
    };

    console.log("mailboxResponse", mailboxResponse);

    return res
      .status(200)
      .json(new ApiResponse(200, "OK", { user: mailboxResponse }));
  }
});

// change pass
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!req.user) return ApiError.send(res, 401, "Not authenticated");
  if (!currentPassword || !newPassword)
    return ApiError.send(res, 400, "Both passwords are required");

  // If user model
  if (req.user.model === "USER") {
    const user = await Prisma.user.findUnique({
      where: { id: req.user.id },
      select: { password: true },
    });
    if (!user) return ApiError.send(res, 404, "User not found");

    const ok = await comparePassword(currentPassword, user.password);
    if (!ok) return ApiError.send(res, 401, "Current password is incorrect");

    const hashed = await hashPassword(newPassword);
    await Prisma.user.update({
      where: { id: req.user.id },
      data: { password: hashed },
    });

    return res
      .status(200)
      .json(new ApiResponse(200, "Password changed successfully"));
  } else {
    // mailbox change password
    const mailbox = await Prisma.mailbox.findUnique({
      where: { id: req.user.id },
      select: { password: true },
    });
    if (!mailbox) return ApiError.send(res, 404, "Mailbox not found");

    const ok = await comparePassword(currentPassword, mailbox.password);
    if (!ok) return ApiError.send(res, 401, "Current password is incorrect");

    const hashed = await hashPassword(newPassword);
    await Prisma.mailbox.update({
      where: { id: req.user.id },
      data: { password: hashed },
    });

    return res
      .status(200)
      .json(new ApiResponse(200, "Password changed successfully"));
  }
});

// forgot pass
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) return ApiError.send(res, 400, "Email is required");

  const user = await Prisma.user.findUnique({ where: { email } });
  if (!user) return ApiError.send(res, 404, "User not found");

  // Create a short lived token (e.g., 1 hour)
  const token = jwt.sign(
    { id: user.id, purpose: "password_reset" },
    process.env.RESET_TOKEN_SECRET,
    {
      expiresIn: "1h",
    }
  );

  // TODO: send email with link in real app
  const resetUrl = `${process.env.FRONTEND_URL || "http://localhost:3000"}/reset-password?token=${token}`;
  console.log("Password reset link (send via email):", resetUrl);

  return res.status(200).json(
    new ApiResponse(200, "Password reset link generated (check logs)", {
      resetUrl,
    })
  );
});

// reset pass
const resetPassword = asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword)
    return ApiError.send(res, 400, "Token and new password are required");

  try {
    const decoded = jwt.verify(token, process.env.RESET_TOKEN_SECRET);
    if (decoded.purpose !== "password_reset")
      return ApiError.send(res, 400, "Invalid reset token");

    const user = await Prisma.user.findUnique({ where: { id: decoded.id } });
    if (!user) return ApiError.send(res, 404, "User not found");

    const hashed = await hashPassword(newPassword);
    await Prisma.user.update({
      where: { id: user.id },
      data: { password: hashed },
    });

    return res
      .status(200)
      .json(new ApiResponse(200, "Password reset successfully"));
  } catch (err) {
    return ApiError.send(res, 400, "Invalid or expired token");
  }
});

// ====================== super admin (no query params) ==========================
export const allAdmins = asyncHandler(async (req, res) => {
  const superAdminId = req.user?.id;
  if (!superAdminId) return ApiError.send(res, 401, "Unauthorized user");
  if (req.user.role !== "SUPER_ADMIN") {
    return ApiError.send(
      res,
      403,
      "Forbidden: Only superadmin can access this"
    );
  }

  const admins = await Prisma.user.findMany({
    where: { role: "ADMIN" },
    orderBy: { createdAt: "desc" },
  });

  return res.status(200).json(
    new ApiResponse(200, "All admins fetched successfully", {
      data: admins,
    })
  );
});

export const toggleAdminStatus = asyncHandler(async (req, res) => {
  const superAdminId = req.user?.id;
  const { userId } = req.params;

  if (!superAdminId) {
    return ApiError.send(res, 401, "Unauthorized user");
  }

  if (req.user.role !== "SUPER_ADMIN") {
    return ApiError.send(
      res,
      403,
      "Forbidden: Only superadmin can access this"
    );
  }

  if (!userId) {
    return ApiError.send(res, 400, "'userId' is required");
  }

  if (userId === superAdminId) {
    return ApiError.send(res, 400, "You cannot update your own status");
  }

  const target = await Prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      isAuthorized: true,
    },
  });

  if (!target) return ApiError.send(res, 404, "Admin not found");
  if (target.role === "SUPER_ADMIN")
    return ApiError.send(res, 403, "Cannot update another super admin");

  const updated = await Prisma.user.update({
    where: { id: userId },
    data: { isActive: !target.isActive },
    select: { id: true, email: true, name: true, role: true, isActive: true },
  });

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        `Admin status toggled to ${updated.isActive ? "Active ✅" : "Inactive ❌"}`,
        updated
      )
    );
});

export const getAllData = asyncHandler(async (req, res) => {
  const superAdminId = req.user?.id;
  if (!superAdminId) return ApiError.send(res, 401, "Unauthorized user");

  if (req.user.role !== "SUPER_ADMIN") {
    return ApiError.send(res, 403, "Forbidden: Only superadmin can access this");
  }

  const page = parseInt(String(req.query.page)) || 1;
  const limit = parseInt(String(req.query.limit)) || 10;

  const [admins, totalAdmins] = await Promise.all([
    Prisma.user.findMany({
      where: { role: "ADMIN" },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        domains: {
          select: { id: true, name: true },
        },
        mailboxes: {
          select: { id: true, emailAddress: true },
        },
        subscriptions: {
          orderBy: { createdAt: "desc" },
          take: 1, // last subscription only
        },
        _count: {
          select: {
            sentEmails: true,
            receivedEmails: true,
          },
        },
      },
    }),
    Prisma.user.count({ where: { role: "ADMIN" } }),
  ]);

  if (!admins || admins.length === 0)
    return ApiError.send(res, 404, "Admins not found");

  const formatted = admins.map((admin) => ({
    id: admin.id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    createdAt: admin.createdAt,
    totalDomains: admin.domains.length,
    domainNames: admin.domains.map((d) => d.name),
    totalMailboxes: admin.mailboxes.length,
    mailboxNames: admin.mailboxes.map((m) => m.email),
    totalSentEmails: admin._count.sentEmails,
    totalReceivedEmails: admin._count.receivedEmails,
    lastSubscription: admin.subscriptions[0] || null,
  }));

  return res.status(200).json(
    new ApiResponse(200, "Admins fetched successfully", {
      totalAdmins,
      page,
      limit,
      admins: formatted,
    })
  );
});

export {
  signup,
  login,
  refreshAccessToken,
  logout,
  getCurrentUser,
  changePassword,
  forgotPassword,
  resetPassword,
  updateProfile,
};
