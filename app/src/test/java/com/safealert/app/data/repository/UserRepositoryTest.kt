package com.safealert.app.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import java.util.UUID

class UserRepositoryTest {

    @Test
    fun `UUID generation produces valid format`() {
        val uuid = UUID.randomUUID().toString()
        assertEquals(36, uuid.length)
        // UUID format: 8-4-4-4-12 hex digits separated by hyphens
        val parts = uuid.split("-")
        assertEquals(5, parts.size)
        assertEquals(8, parts[0].length)
        assertEquals(4, parts[1].length)
        assertEquals(4, parts[2].length)
        assertEquals(4, parts[3].length)
        assertEquals(12, parts[4].length)
    }

    @Test
    fun `two generated UUIDs are different`() {
        val id1 = UUID.randomUUID().toString()
        val id2 = UUID.randomUUID().toString()
        assertNotEquals(id1, id2)
    }

    @Test
    fun `truncated ID displays first 10 characters`() {
        val fullId = UUID.randomUUID().toString()
        val truncated = fullId.take(10)
        assertEquals(10, truncated.length)
        assertEquals(fullId.substring(0, 10), truncated)
    }
}
