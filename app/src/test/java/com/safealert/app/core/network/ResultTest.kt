package com.safealert.app.core.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ResultTest {

    @Test
    fun `Success holds data`() {
        val data = "test data"
        val result = Result.Success(data)
        assertEquals(data, result.data)
    }

    @Test
    fun `Error contains throwable`() {
        val exception = Exception("test error")
        val result = Result.Error(exception)
        assertEquals(exception, result.error)
    }

    @Test
    fun `Loading is a singleton`() {
        val result1 = Result.Loading
        val result2 = Result.Loading
        assertEquals(result1, result2)
    }

    @Test
    fun `Success and Error are different types`() {
        val resultSuccess: Result<Int> = Result.Success(1)
        val resultError: Result<Int> = Result.Error(Exception())
        assertNotSame(resultSuccess::class, resultError::class)
    }

    @Test
    fun `Success is instanceof Result`() {
        val result: Result<String> = Result.Success("hello")
        assertTrue(result is Result.Success)
    }
}
