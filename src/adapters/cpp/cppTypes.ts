/**
 * cppTypes.ts — C++ type detection patterns (Layer-1 quick detection).
 *
 * Maps C++ type name strings from the DAP `type` field to VisualizableKind.
 * Add patterns here as new C++ container/matrix types are supported.
 *
 * Expected type strings (from cppdbg / lldb DAP responses):
 *   - "cv::Mat"                   → image
 *   - "Eigen::Matrix<float,-1,-1>" → image / plot / pointcloud
 *   - "std::vector<double>"        → plot
 *   - "pcl::PointCloud<...>"       → pointcloud
 */

import { VisualizableKind } from "../IDebugAdapter";

// ── Pattern tables ────────────────────────────────────────────────────────

const IMAGE_TYPE_PATTERNS = [
  /\bcv::Mat\b/i,
  /\bcv2::Mat\b/i,
  /\bEigen::Matrix\b/,   // 2D matrix — refined in Layer 2 once shape known
  /\bEigen::Array\b/,    // 2D array — same
];

const PLOT_TYPE_PATTERNS = [
  /\bstd::vector\b/,
  /\bEigen::Vector/,     // Eigen::VectorXf, VectorXd, etc.
  /\bstd::array\b/,
  /\bstd::deque\b/,
];

const POINTCLOUD_TYPE_PATTERNS = [
  /\bpcl::PointCloud\b/,
  /\bopen3d::geometry::PointCloud\b/,
];

// ── Layer-1 detection ─────────────────────────────────────────────────────

/**
 * Quick detection from the raw DAP type string.
 * Returns "unknown" when no pattern matches.
 */
export function basicTypeDetect(typeStr: string): VisualizableKind {
  for (const pat of IMAGE_TYPE_PATTERNS) {
    if (pat.test(typeStr)) {
      return "image";
    }
  }
  for (const pat of PLOT_TYPE_PATTERNS) {
    if (pat.test(typeStr)) {
      return "plot";
    }
  }
  for (const pat of POINTCLOUD_TYPE_PATTERNS) {
    if (pat.test(typeStr)) {
      return "pointcloud";
    }
  }
  return "unknown";
}
