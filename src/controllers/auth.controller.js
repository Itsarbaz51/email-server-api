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

// signup on role base protected middleware by super-admin and admin role base
const signupAdmin = asyncHandler(async (req, res) => {
  const { name, email, password, role } = req.body;

  if (![name, email, password].every((v) => v && String(v).trim().length > 0)) {
    return ApiError.send(res, 400, "All fields are required");
  }

  const existingUser = await Prisma.user.findUnique({ where: { email } });
  if (existingUser) return ApiError.send(res, 409, "Email already registered");

  const hashedPassword = await hashPassword(password);

  // Check if a SUPER_ADMIN already exists in DB
  let finalRole = "ADMIN"; // default

  if (role === "SUPER_ADMIN") {
    const existingSuperAdmin = await Prisma.user.findFirst({
      where: { role: "SUPER_ADMIN" },
    });
    if (!existingSuperAdmin) {
      finalRole = "SUPER_ADMIN";
    }
  } else {
    finalRole = "ADMIN"; // force admin if role not SUPER_ADMIN
  }

  const created = await Prisma.user.create({
    data: {
      name,
      email,
      password: hashedPassword,
      role: finalRole,
    },
  });

  if (!created) return ApiError.send(res, 500, "User creation failed");

  return res
    .status(201)
    .json(
      new ApiResponse(201, "Admin registered successfully", { id: created.id })
    );
});

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

  const user = await Prisma.user.findFirst({
    where: {
      OR: [{ email: emailOrPhone.toLowerCase() }, { phone: emailOrPhone }],
    },
    select: { id: true, email: true, password: true, role: true, name: true },
  });

  if (!user) {
    const exitsMailbox = await Prisma.mailbox.findFirst({
      where: { emailAddress: emailOrPhone }
    });

    if (!exitsMailbox) return ApiError.send(res, 404, "Mailbox user not found");

    const checkedPassword = await comparePassword(password, exitsMailbox.password);
    if (!checkedPassword) return ApiError.send(res, 403, "Password Invalid");

    const accessToken = generateAccessToken(
      exitsMailbox.id,
      exitsMailbox.emailAddress,
      "USER"
    );
    const refreshToken = generateRefreshToken(
      exitsMailbox.id,
      exitsMailbox.emailAddress,
      "USER"
    );

    // mailboxSafe object me role inject karna
    const { password: _, ...mailboxSafe } = exitsMailbox;
    const mailboxResponse = {
      ...mailboxSafe,
      role: "USER"
    };

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
      .json(new ApiResponse(200, "Login successful", mailboxResponse));
  }

  console.log("USER FOUND:", user);

  console.log(await comparePassword(password, user.password));

  if (!user || !(await comparePassword(password, user.password))) {
    return ApiError.send(res, 401, "Invalid credentials");
  }

  const accessToken = generateAccessToken(user.id, user.email, user.role);
  const refreshToken = generateRefreshToken(user.id, user.email, user.role);

  const { password: _, ...userSafe } = user;

  console.log("TOKENS:", { accessToken, refreshToken });
  console.log("RESPONDING WITH USER:", userSafe);

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
    .json(new ApiResponse(200, "Login successful", userSafe));
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

// update profile
const updateProfile = asyncHandler(async (req, res) => {
  if (!req.user || !req.user.id)
    return ApiError.send(res, 401, "Not authenticated");

  const { name, email, phone, password } = req.body;

  // Check: at least one field required
  if (![name, email, phone, password].some((field) => field && field.trim && field.trim() !== "")) {
    return ApiError.send(res, 400, "At least one field is required to update profile");
  }

  // Prepare update data dynamically
  const updateData = {};
  if (name) updateData.name = name;
  if (email) updateData.email = email;
  if (phone) updateData.phone = phone;
  if (password) {
    const hashedPassword = await bcrypt.hash(password, 10);
    updateData.password = hashedPassword;
  }

  // Update in DB
  const updatedUser = await Prisma.user.update({
    where: { id: req.user.id },
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

  return res
    .status(200)
    .json(new ApiResponse(200, "Profile updated successfully", { user: updatedUser }));
});

// get current user
const getCurrentUser = asyncHandler(async (req, res) => {
  const userId = req.user || req.user.id
  const mailboxId = req.mailbox || req.mailbox.id

  if (!userId || !mailboxId)
    return ApiError.send(res, 401, "Not authenticated");

  if (userId) {

    const user = await Prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true, isActive: true, phone: true, createdAt: true },
    });

    if (!user) return ApiError.send(res, 404, "User not found");

    return res.status(200).json(new ApiResponse(200, "OK", { user: user }));
  }

  if (mailboxId) {

    const mailboxExits = await Prisma.user.findUnique({
      where: { id: mailboxId },
    });


    if (!mailboxExits) return ApiError.send(res, 404, "mailbox user not found")
    const { password: _, ...mailboxSafe } = mailboxExits;

    const mailboxResponse = {
      ...mailboxSafe,
      role: "USER"
    };


    return res.status(200).json(new ApiResponse(200, "OK", { user: mailboxResponse }));
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

export {
  signupAdmin,
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
